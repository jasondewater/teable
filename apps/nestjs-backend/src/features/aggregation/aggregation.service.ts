import { Injectable, Logger } from '@nestjs/common';
import type { IGridColumnMeta, IFilter, IGroup } from '@teable/core';
import { mergeWithDefaultFilter, nullsToUndefined, StatisticsFunc, ViewType } from '@teable/core';
import type { Prisma } from '@teable/db-main-prisma';
import { PrismaService } from '@teable/db-main-prisma';
import type {
  IAggregationField,
  IGetRecordsRo,
  IQueryBaseRo,
  IRawAggregations,
  IRawAggregationValue,
  IRawRowCountValue,
  IGroupPointsRo,
  ISearchIndexByQueryRo,
  ISearchCountRo,
} from '@teable/openapi';
import dayjs from 'dayjs';
import { Knex } from 'knex';
import { get, groupBy, isDate, isEmpty, keyBy } from 'lodash';
import { InjectModel } from 'nest-knexjs';
import { ClsService } from 'nestjs-cls';
import { IThresholdConfig, ThresholdConfig } from '../../configs/threshold.config';
import { InjectDbProvider } from '../../db-provider/db.provider';
import { IDbProvider } from '../../db-provider/db.provider.interface';
import type { IClsStore } from '../../types/cls';
import { convertValueToStringify, string2Hash } from '../../utils';
import type { IFieldInstance } from '../field/model/factory';
import { createFieldInstanceByRaw } from '../field/model/factory';
import { RecordService } from '../record/record.service';

export type IWithView = {
  viewId?: string;
  groupBy?: IGroup;
  customFilter?: IFilter;
  customFieldStats?: ICustomFieldStats[];
};

type ICustomFieldStats = {
  fieldId: string;
  statisticFunc?: StatisticsFunc;
};

type IStatisticsData = {
  viewId?: string;
  filter?: IFilter;
  statisticFields?: IAggregationField[];
};

@Injectable()
export class AggregationService {
  private logger = new Logger(AggregationService.name);

  constructor(
    private readonly recordService: RecordService,
    private readonly prisma: PrismaService,
    @InjectModel('CUSTOM_KNEX') private readonly knex: Knex,
    @InjectDbProvider() private readonly dbProvider: IDbProvider,
    private readonly cls: ClsService<IClsStore>,
    @ThresholdConfig() private readonly thresholdConfig: IThresholdConfig
  ) {}

  async performAggregation(params: {
    tableId: string;
    withFieldIds?: string[];
    withView?: IWithView;
    search?: [string, string?, boolean?];
  }): Promise<IRawAggregationValue> {
    const { tableId, withFieldIds, withView, search } = params;
    // Retrieve the current user's ID to build user-related query conditions
    const currentUserId = this.cls.get('user.id');

    const { statisticsData, fieldInstanceMap, fieldInstanceMapWithoutHiddenFields } =
      await this.fetchStatisticsParams({
        tableId,
        withView,
        withFieldIds,
      });

    const dbTableName = await this.getDbTableName(this.prisma, tableId);

    const { filter, statisticFields } = statisticsData;
    const groupBy = withView?.groupBy;

    const rawAggregationData = await this.handleAggregation({
      dbTableName,
      fieldInstanceMap,
      fieldInstanceMapWithoutHiddenFields,
      filter,
      search,
      statisticFields,
      withUserId: currentUserId,
    });

    const aggregationResult = rawAggregationData && rawAggregationData[0];

    const aggregations: IRawAggregations = [];
    if (aggregationResult) {
      for (const [key, value] of Object.entries(aggregationResult)) {
        const [fieldId, aggFunc] = key.split('_') as [string, StatisticsFunc | undefined];

        const convertValue = this.formatConvertValue(value, aggFunc);

        if (fieldId) {
          aggregations.push({
            fieldId,
            total: aggFunc ? { value: convertValue, aggFunc: aggFunc } : null,
          });
        }
      }
    }

    const aggregationsWithGroup = await this.performGroupedAggregation({
      aggregations,
      statisticFields,
      filter,
      search,
      groupBy,
      dbTableName,
      fieldInstanceMap,
      fieldInstanceMapWithoutHiddenFields,
    });

    return { aggregations: aggregationsWithGroup };
  }

  async performGroupedAggregation(params: {
    aggregations: IRawAggregations;
    statisticFields: IAggregationField[] | undefined;
    filter?: IFilter;
    search?: [string, string?, boolean?];
    groupBy?: IGroup;
    dbTableName: string;
    fieldInstanceMap: Record<string, IFieldInstance>;
    fieldInstanceMapWithoutHiddenFields: Record<string, IFieldInstance>;
  }) {
    const {
      dbTableName,
      aggregations,
      statisticFields,
      filter,
      groupBy,
      search,
      fieldInstanceMap,
      fieldInstanceMapWithoutHiddenFields,
    } = params;

    if (!groupBy || !statisticFields) return aggregations;

    const currentUserId = this.cls.get('user.id');
    const aggregationByFieldId = keyBy(aggregations, 'fieldId');

    const groupByFields = groupBy.map(({ fieldId }) => {
      return {
        fieldId,
        dbFieldName: fieldInstanceMap[fieldId].dbFieldName,
      };
    });

    for (let i = 0; i < groupBy.length; i++) {
      const rawGroupedAggregationData = (await this.handleAggregation({
        dbTableName,
        fieldInstanceMap,
        fieldInstanceMapWithoutHiddenFields,
        filter,
        groupBy: groupBy.slice(0, i + 1),
        search,
        statisticFields,
        withUserId: currentUserId,
      }))!;

      const currentGroupFieldId = groupByFields[i].fieldId;

      for (const groupedAggregation of rawGroupedAggregationData) {
        const groupByValueString = groupByFields
          .slice(0, i + 1)
          .map(({ dbFieldName }) => {
            const groupByValue = groupedAggregation[dbFieldName];
            return convertValueToStringify(groupByValue);
          })
          .join('_');
        const flagString = `${currentGroupFieldId}_${groupByValueString}`;
        const groupId = String(string2Hash(flagString));

        for (const statisticField of statisticFields) {
          const { fieldId, statisticFunc } = statisticField;
          const aggKey = `${fieldId}_${statisticFunc}`;
          const curFieldAggregation = aggregationByFieldId[fieldId]!;
          const convertValue = this.formatConvertValue(groupedAggregation[aggKey], statisticFunc);

          if (!curFieldAggregation.group) {
            aggregationByFieldId[fieldId].group = {
              [groupId]: { value: convertValue, aggFunc: statisticFunc },
            };
          } else {
            aggregationByFieldId[fieldId]!.group![groupId] = {
              value: convertValue,
              aggFunc: statisticFunc,
            };
          }
        }
      }
    }

    return Object.values(aggregationByFieldId);
  }

  async performRowCount(tableId: string, queryRo: IQueryBaseRo): Promise<IRawRowCountValue> {
    const { filterLinkCellCandidate, filterLinkCellSelected, selectedRecordIds } = queryRo;
    // Retrieve the current user's ID to build user-related query conditions
    const currentUserId = this.cls.get('user.id');

    const { statisticsData, fieldInstanceMap, fieldInstanceMapWithoutHiddenFields } =
      await this.fetchStatisticsParams({
        tableId,
        withView: {
          viewId: queryRo.viewId,
          customFilter: queryRo.filter,
        },
      });

    const dbTableName = await this.getDbTableName(this.prisma, tableId);

    const { filter } = statisticsData;

    const rawRowCountData = await this.handleRowCount({
      tableId,
      dbTableName,
      fieldInstanceMap,
      fieldInstanceMapWithoutHiddenFields,
      filter,
      filterLinkCellCandidate,
      filterLinkCellSelected,
      selectedRecordIds,
      search: queryRo.search,
      withUserId: currentUserId,
    });

    return {
      rowCount: Number(rawRowCountData[0]?.count ?? 0),
    };
  }

  private async fetchStatisticsParams(params: {
    tableId: string;
    withView?: IWithView;
    withFieldIds?: string[];
  }): Promise<{
    statisticsData: IStatisticsData;
    fieldInstanceMap: Record<string, IFieldInstance>;
    fieldInstanceMapWithoutHiddenFields: Record<string, IFieldInstance>;
  }> {
    const { tableId, withView, withFieldIds } = params;

    const viewRaw = await this.findView(tableId, withView);

    const { fieldInstances, fieldInstanceMap } = await this.getFieldsData(tableId);
    const filteredFieldInstances = this.filterFieldInstances(
      fieldInstances,
      withView,
      withFieldIds
    );

    const statisticsData = this.buildStatisticsData(filteredFieldInstances, viewRaw, withView);

    const fieldInstanceMapWithoutHiddenFields = { ...fieldInstanceMap };

    if (viewRaw?.columnMeta) {
      const columnMeta = JSON.parse(viewRaw?.columnMeta);
      Object.entries(columnMeta).forEach(([key, value]) => {
        if (get(value, ['hidden'])) {
          delete fieldInstanceMapWithoutHiddenFields[key];
        }
      });
    }
    return { statisticsData, fieldInstanceMap, fieldInstanceMapWithoutHiddenFields };
  }

  private async findView(tableId: string, withView?: IWithView) {
    if (!withView?.viewId) {
      return undefined;
    }

    return nullsToUndefined(
      await this.prisma.view.findFirst({
        select: { id: true, columnMeta: true, filter: true, group: true },
        where: {
          tableId,
          ...(withView?.viewId ? { id: withView.viewId } : {}),
          type: { in: [ViewType.Grid, ViewType.Gantt, ViewType.Kanban, ViewType.Gallery] },
          deletedTime: null,
        },
      })
    );
  }

  private filterFieldInstances(
    fieldInstances: IFieldInstance[],
    withView?: IWithView,
    withFieldIds?: string[]
  ) {
    const targetFieldIds =
      withView?.customFieldStats?.map((field) => field.fieldId) ?? withFieldIds;

    return targetFieldIds?.length
      ? fieldInstances.filter((instance) => targetFieldIds.includes(instance.id))
      : fieldInstances;
  }

  private buildStatisticsData(
    filteredFieldInstances: IFieldInstance[],
    viewRaw:
      | {
          id: string | undefined;
          columnMeta: string | undefined;
          filter: string | undefined;
          group: string | undefined;
        }
      | undefined,
    withView?: IWithView
  ) {
    let statisticsData: IStatisticsData = {
      viewId: viewRaw?.id,
    };

    if (viewRaw?.filter || withView?.customFilter) {
      const filter = mergeWithDefaultFilter(viewRaw?.filter, withView?.customFilter);
      statisticsData = { ...statisticsData, filter };
    }

    if (viewRaw?.id || withView?.customFieldStats) {
      const statisticFields = this.getStatisticFields(
        filteredFieldInstances,
        viewRaw?.columnMeta && JSON.parse(viewRaw.columnMeta),
        withView?.customFieldStats
      );
      statisticsData = { ...statisticsData, statisticFields };
    }
    return statisticsData;
  }

  async getFieldsData(tableId: string, fieldIds?: string[], withName?: boolean) {
    const fieldsRaw = await this.prisma.field.findMany({
      where: { tableId, ...(fieldIds ? { id: { in: fieldIds } } : {}), deletedTime: null },
    });

    const fieldInstances = fieldsRaw.map((field) => createFieldInstanceByRaw(field));
    const fieldInstanceMap = fieldInstances.reduce(
      (map, field) => {
        map[field.id] = field;
        if (withName || withName === undefined) {
          map[field.name] = field;
        }
        return map;
      },
      {} as Record<string, IFieldInstance>
    );
    return { fieldInstances, fieldInstanceMap };
  }

  private getStatisticFields(
    fieldInstances: IFieldInstance[],
    columnMeta?: IGridColumnMeta,
    customFieldStats?: ICustomFieldStats[]
  ) {
    let calculatedStatisticFields: IAggregationField[] | undefined;
    const customFieldStatsGrouped = groupBy(customFieldStats, 'fieldId');

    fieldInstances.forEach((fieldInstance) => {
      const { id: fieldId } = fieldInstance;
      const viewColumnMeta = columnMeta ? columnMeta[fieldId] : undefined;
      const customFieldStats = customFieldStatsGrouped[fieldId];

      if (viewColumnMeta || customFieldStats) {
        const { hidden, statisticFunc } = viewColumnMeta || {};
        const statisticFuncList = customFieldStats
          ?.filter((item) => item.statisticFunc)
          ?.map((item) => item.statisticFunc) as StatisticsFunc[];

        const funcList = !isEmpty(statisticFuncList)
          ? statisticFuncList
          : statisticFunc && [statisticFunc];

        if (hidden !== true && funcList && funcList.length) {
          const statisticFieldList = funcList.map((item) => {
            return {
              fieldId,
              statisticFunc: item,
            };
          });
          (calculatedStatisticFields = calculatedStatisticFields ?? []).push(...statisticFieldList);
        }
      }
    });
    return calculatedStatisticFields;
  }

  private async handleAggregation(params: {
    dbTableName: string;
    fieldInstanceMap: Record<string, IFieldInstance>;
    fieldInstanceMapWithoutHiddenFields: Record<string, IFieldInstance>;
    filter?: IFilter;
    groupBy?: IGroup;
    search?: [string, string?, boolean?];
    statisticFields?: IAggregationField[];
    withUserId?: string;
  }) {
    const { dbTableName, fieldInstanceMap, filter, search, statisticFields, withUserId, groupBy } =
      params;

    if (!statisticFields?.length) {
      return;
    }

    const tableAlias = 'main_table';
    const queryBuilder = this.knex
      .with(tableAlias, (qb) => {
        qb.select('*').from(dbTableName);
        if (filter) {
          this.dbProvider
            .filterQuery(qb, fieldInstanceMap, filter, { withUserId })
            .appendQueryBuilder();
        }
        if (search && search[2]) {
          qb.where((builder) => {
            this.dbProvider.searchQuery(builder, fieldInstanceMap, search);
          });
        }
      })
      .from(tableAlias);

    const qb = this.dbProvider
      .aggregationQuery(queryBuilder, tableAlias, fieldInstanceMap, statisticFields)
      .appendBuilder();

    if (groupBy) {
      this.dbProvider
        .groupQuery(
          qb,
          fieldInstanceMap,
          groupBy.map((item) => item.fieldId)
        )
        .appendGroupBuilder();
    }
    const aggSql = qb.toQuery();
    return this.prisma.$queryRawUnsafe<{ [field: string]: unknown }[]>(aggSql);
  }

  private async handleRowCount(params: {
    tableId: string;
    dbTableName: string;
    fieldInstanceMap: Record<string, IFieldInstance>;
    fieldInstanceMapWithoutHiddenFields: Record<string, IFieldInstance>;
    filter?: IFilter;
    filterLinkCellCandidate?: IGetRecordsRo['filterLinkCellCandidate'];
    filterLinkCellSelected?: IGetRecordsRo['filterLinkCellSelected'];
    selectedRecordIds?: IGetRecordsRo['selectedRecordIds'];
    search?: [string, string?, boolean?];
    withUserId?: string;
  }) {
    const {
      tableId,
      dbTableName,
      fieldInstanceMap,
      fieldInstanceMapWithoutHiddenFields,
      filter,
      filterLinkCellCandidate,
      filterLinkCellSelected,
      selectedRecordIds,
      search,
      withUserId,
    } = params;

    const queryBuilder = this.knex(dbTableName);

    if (filter) {
      this.dbProvider
        .filterQuery(queryBuilder, fieldInstanceMap, filter, { withUserId })
        .appendQueryBuilder();
    }

    if (search && search[2]) {
      queryBuilder.where((builder) => {
        this.dbProvider.searchQuery(builder, fieldInstanceMapWithoutHiddenFields, search);
      });
    }

    if (selectedRecordIds) {
      filterLinkCellCandidate
        ? queryBuilder.whereNotIn(`${dbTableName}.__id`, selectedRecordIds)
        : queryBuilder.whereIn(`${dbTableName}.__id`, selectedRecordIds);
    }

    if (filterLinkCellCandidate) {
      await this.recordService.buildLinkCandidateQuery(
        queryBuilder,
        tableId,
        dbTableName,
        filterLinkCellCandidate
      );
    }

    if (filterLinkCellSelected) {
      await this.recordService.buildLinkSelectedQuery(
        queryBuilder,
        tableId,
        dbTableName,
        filterLinkCellSelected
      );
    }

    return this.getRowCount(this.prisma, queryBuilder);
  }

  private convertValueToNumberOrString(currentValue: unknown): number | string | null {
    if (typeof currentValue === 'bigint' || typeof currentValue === 'number') {
      return Number(currentValue);
    }
    if (isDate(currentValue)) {
      return currentValue.toISOString();
    }
    return currentValue?.toString() ?? null;
  }

  private calculateDateRangeOfMonths(currentValue: string): number {
    const [maxTime, minTime] = currentValue.split(',');
    return maxTime && minTime ? dayjs(maxTime).diff(minTime, 'month') : 0;
  }

  private formatConvertValue = (currentValue: unknown, aggFunc?: StatisticsFunc) => {
    let convertValue = this.convertValueToNumberOrString(currentValue);

    if (!aggFunc) {
      return convertValue;
    }

    if (aggFunc === StatisticsFunc.DateRangeOfMonths && typeof currentValue === 'string') {
      convertValue = this.calculateDateRangeOfMonths(currentValue);
    }

    const defaultToZero = [
      StatisticsFunc.PercentEmpty,
      StatisticsFunc.PercentFilled,
      StatisticsFunc.PercentUnique,
      StatisticsFunc.PercentChecked,
      StatisticsFunc.PercentUnChecked,
    ];

    if (defaultToZero.includes(aggFunc)) {
      convertValue = convertValue ?? 0;
    }
    return convertValue;
  };

  private async getDbTableName(prisma: Prisma.TransactionClient, tableId: string) {
    const tableMeta = await prisma.tableMeta.findUniqueOrThrow({
      where: { id: tableId },
      select: { dbTableName: true },
    });
    return tableMeta.dbTableName;
  }

  private async getRowCount(prisma: Prisma.TransactionClient, queryBuilder: Knex.QueryBuilder) {
    queryBuilder
      .clearSelect()
      .clearCounters()
      .clearGroup()
      .clearHaving()
      .clearOrder()
      .clear('limit')
      .clear('offset');
    const rowCountSql = queryBuilder.count({ count: '*' });

    return prisma.$queryRawUnsafe<{ count?: number }[]>(rowCountSql.toQuery());
  }

  public async getGroupPoints(tableId: string, query?: IGroupPointsRo) {
    const { groupPoints } = await this.recordService.getGroupRelatedData(tableId, query);
    return groupPoints;
  }

  public async getSearchCount(tableId: string, queryRo: ISearchCountRo, projection?: string[]) {
    const { search, viewId } = queryRo;
    const { queryBuilder: viewRecordsQB } = await this.recordService.buildFilterSortQuery(
      tableId,
      queryRo
    );
    const { fieldInstanceMap } = await this.getFieldsData(tableId, undefined, false);

    const fieldInstanceMapWithoutHiddenFields = { ...fieldInstanceMap };

    if (viewId) {
      const { columnMeta: rawColumnMeta } =
        (await this.prisma.view.findUnique({
          where: { id: viewId, deletedTime: null },
        })) || {};

      const columnMeta = rawColumnMeta ? JSON.parse(rawColumnMeta) : null;

      if (columnMeta) {
        Object.entries(columnMeta).forEach(([key, value]) => {
          if (get(value, ['hidden'])) {
            delete fieldInstanceMapWithoutHiddenFields[key];
          }
        });
      }
    }

    if (projection?.length) {
      Object.keys(fieldInstanceMap).forEach((fieldId) => {
        if (!projection.includes(fieldId)) {
          delete fieldInstanceMapWithoutHiddenFields[fieldId];
        }
      });
    }

    const queryBuilder = this.knex
      .with('viewTable', (qb) => {
        qb.select('*').from(viewRecordsQB.as('t'));
      })
      .select(this.knex.raw('COUNT(*) as count'));

    if (search) {
      queryBuilder.from((qb: Knex.QueryBuilder) => {
        this.dbProvider.searchCountQuery(
          qb,
          fieldInstanceMapWithoutHiddenFields,
          search,
          'viewTable'
        );
      });
    }

    const sql = queryBuilder.toQuery();

    const result = await this.prisma.$queryRawUnsafe<{ count: number }[] | null>(sql);

    return {
      count: result ? Number(result[0]?.count) : 0,
    };
  }

  public async getRecordIndexBySearchOrder(
    tableId: string,
    queryRo: ISearchIndexByQueryRo,
    projection?: string[]
  ) {
    const { search, index = 1, orderBy, groupBy, viewId } = queryRo;
    const dbTableName = await this.getDbTableName(this.prisma, tableId);
    const { fieldInstanceMap } = await this.getFieldsData(tableId, undefined, false);

    let viewColumnMeta: IGridColumnMeta | null = null;
    const fieldInstanceMapWithoutHiddenFields = { ...fieldInstanceMap };

    if (viewId) {
      const { columnMeta: viewColumnRawMeta } =
        (await this.prisma.view.findUnique({
          where: { id: viewId, deletedTime: null },
          select: { columnMeta: true },
        })) || {};

      viewColumnMeta = viewColumnRawMeta ? JSON.parse(viewColumnRawMeta) : null;

      if (viewColumnMeta) {
        Object.entries(viewColumnMeta).forEach(([key, value]) => {
          if (get(value, ['hidden'])) {
            delete fieldInstanceMapWithoutHiddenFields[key];
          }
        });
      }
    }

    if (projection?.length) {
      Object.keys(fieldInstanceMap).forEach((fieldId) => {
        if (!projection.includes(fieldId)) {
          delete fieldInstanceMapWithoutHiddenFields[fieldId];
        }
      });
    }

    const fieldsWithOrder = Object.values(fieldInstanceMap)
      .filter((field) => {
        if (!viewColumnMeta) {
          return true;
        }
        return !viewColumnMeta?.[field.id]?.hidden;
      })
      .filter((field) => {
        if (!projection) {
          return true;
        }
        return projection.includes(field.id);
      })
      .map((field) => {
        return {
          ...field,
          order: viewColumnMeta?.[field.id]?.order ?? Number.MIN_SAFE_INTEGER,
        };
      })
      .sort((a, b) => a.order - b.order);

    const { queryBuilder: viewRecordsQB } = await this.recordService.buildFilterSortQuery(
      tableId,
      queryRo
    );
    const basicSortIndex = await this.recordService.getBasicOrderIndexField(dbTableName, viewId);

    // step 1. find the record in specific order
    const queryBuilder = this.knex.with('table_with_view', (qb) => {
      qb.select('*').from(viewRecordsQB.as('t_w_v'));
    });

    if (search) {
      queryBuilder.from((qb: Knex.QueryBuilder) => {
        this.dbProvider.searchCountQuery(
          qb,
          fieldInstanceMapWithoutHiddenFields,
          search,
          'table_with_view'
        );
      });

      const caseStatements = fieldsWithOrder.map((field) => ({
        sql: 'CASE WHEN ?? = ? THEN ? END',
        bindings: ['dbFieldName', field.dbFieldName, field.id],
      }));

      queryBuilder
        .select(
          '__id',
          '__auto_number',
          this.knex.raw(`COALESCE(??) as "fieldId"`, [
            caseStatements.map((c) => this.knex.raw(c.sql, c.bindings)),
          ])
        )
        .limit(1)
        .offset(Number(index) - 1);

      this.dbProvider
        .sortQuery(queryBuilder, fieldInstanceMap, [...(groupBy ?? []), ...(orderBy ?? [])])
        .appendSortBuilder();
      if (orderBy?.length) {
        this.dbProvider.sortQuery(queryBuilder, fieldInstanceMap, orderBy).appendSortBuilder();
      }

      queryBuilder.orderBy(basicSortIndex, 'asc');
      const cases = fieldsWithOrder.map((field, index) => {
        return this.knex.raw(`CASE WHEN ?? = ? THEN ? END`, [
          'dbFieldName',
          field.dbFieldName,
          index + 1,
        ]);
      });
      cases.length && queryBuilder.orderByRaw(cases.join(','));
    }

    const sql = queryBuilder.toQuery();

    const result = await this.prisma.$queryRawUnsafe<{ __id: string; fieldId: string }[]>(sql);

    // no result found
    if (result?.length === 0) {
      return null;
    }

    const recordId = result[0]?.__id;

    // step 2. find the index in current view
    const indexQueryBuilder = this.knex
      .select('row_num')
      .from((qb: Knex.QueryBuilder) => {
        qb.select('__id')
          .select(this.knex.client.raw('ROW_NUMBER() OVER () as row_num'))
          .from(viewRecordsQB.as('t'))
          .as('t1');
      })
      .andWhere('__id', '=', recordId)
      .first();

    // eslint-disable-next-line
    const indexResult = await this.prisma.$queryRawUnsafe<{ row_num: number }[]>(
      indexQueryBuilder.toQuery()
    );

    if (indexResult?.length === 0) {
      return null;
    }

    return {
      index: Number(indexResult[0]?.row_num),
      fieldId: result[0]?.fieldId,
    };
  }
}
