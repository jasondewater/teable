import { BadRequestException, Injectable } from '@nestjs/common';
import type {
  CellValueType,
  IFieldRo,
  IFormulaFieldOptions,
  ILinkFieldOptions,
  INumberFieldOptions,
  IRollupFieldOptions,
} from '@teable-group/core';
import {
  getDefaultFormatting,
  FieldType,
  generateFieldId,
  Relationship,
  RelationshipRevert,
} from '@teable-group/core';
import type { Prisma } from '@teable-group/db-main-prisma';
import knex from 'knex';
import { keyBy } from 'lodash';
import { PrismaService } from '../../prisma.service';
import type { ISupplementService } from '../../share-db/interface';
import type { IFieldInstance } from './model/factory';
import { createFieldInstanceByRaw, createFieldInstanceByRo } from './model/factory';
import { FormulaFieldDto } from './model/field-dto/formula-field.dto';
import type { LinkFieldDto } from './model/field-dto/link-field.dto';
import { RollupFieldDto } from './model/field-dto/rollup-field.dto';

@Injectable()
export class FieldSupplementService implements ISupplementService {
  private readonly knex = knex({ client: 'sqlite3' });
  constructor(private readonly prismaService: PrismaService) {}

  private async getDbTableName(prisma: Prisma.TransactionClient, tableId: string) {
    const tableMeta = await prisma.tableMeta.findUniqueOrThrow({
      where: { id: tableId },
      select: { dbTableName: true },
    });
    return tableMeta.dbTableName;
  }

  private getForeignKeyFieldName(fieldId: string) {
    return `__fk_${fieldId}`;
  }

  private async getDefaultLinkName(foreignTableId: string) {
    const tableRaw = await this.prismaService.tableMeta.findUnique({
      where: { id: foreignTableId },
      select: { name: true },
    });
    if (!tableRaw) {
      throw new BadRequestException(`foreignTableId ${foreignTableId} is invalid`);
    }
    return tableRaw.name;
  }

  private async prepareLinkField(field: IFieldRo): Promise<IFieldRo> {
    const { relationship, foreignTableId } = field.options as LinkFieldDto['options'];
    const { id: lookupFieldId } = await this.prismaService.field.findFirstOrThrow({
      where: { tableId: foreignTableId, isPrimary: true },
      select: { id: true },
    });
    const fieldId = field.id ?? generateFieldId();
    const symmetricFieldId = generateFieldId();
    let dbForeignKeyName = '';
    if (relationship === Relationship.ManyOne) {
      dbForeignKeyName = this.getForeignKeyFieldName(fieldId);
    }
    if (relationship === Relationship.OneMany) {
      dbForeignKeyName = this.getForeignKeyFieldName(symmetricFieldId);
    }

    return {
      ...field,
      id: fieldId,
      name: field.name ?? (await this.getDefaultLinkName(foreignTableId)),
      options: {
        relationship,
        foreignTableId,
        lookupFieldId,
        dbForeignKeyName,
        symmetricFieldId,
      },
    };
  }

  private async prepareLookupOptions(field: IFieldRo, batchFieldRos?: IFieldRo[]) {
    const { lookupOptions } = field;
    if (!lookupOptions) {
      throw new BadRequestException('lookupOptions is required');
    }

    const { linkFieldId, lookupFieldId, foreignTableId } = lookupOptions;
    const linkFieldRaw = await this.prismaService.field.findFirst({
      where: { id: linkFieldId, deletedTime: null, type: FieldType.Link },
      select: { name: true, options: true },
    });

    const optionsRaw = linkFieldRaw?.options || null;
    const linkFieldOptions: ILinkFieldOptions =
      (optionsRaw && JSON.parse(optionsRaw as string)) ||
      batchFieldRos?.find((field) => field.id === linkFieldId);

    if (!linkFieldOptions || !linkFieldRaw) {
      throw new BadRequestException(`linkFieldId ${linkFieldId} is invalid`);
    }

    if (foreignTableId !== linkFieldOptions.foreignTableId) {
      throw new BadRequestException(`foreignTableId ${foreignTableId} is invalid`);
    }

    const lookupFieldRaw = await this.prismaService.field.findFirst({
      where: { id: lookupFieldId, deletedTime: null },
    });

    if (!lookupFieldRaw) {
      throw new BadRequestException(`Lookup field ${lookupFieldId} is not exist`);
    }

    return {
      lookupOptions: {
        linkFieldId,
        lookupFieldId,
        foreignTableId,
        relationship: linkFieldOptions.relationship,
        dbForeignKeyName: linkFieldOptions.dbForeignKeyName,
      },
      lookupFieldRaw,
      linkFieldRaw,
    };
  }

  private async prepareLookupField(field: IFieldRo, batchFieldRos?: IFieldRo[]): Promise<IFieldRo> {
    const { lookupOptions, lookupFieldRaw, linkFieldRaw } = await this.prepareLookupOptions(
      field,
      batchFieldRos
    );

    if (lookupFieldRaw.type !== field.type) {
      throw new BadRequestException(
        `Current field type ${field.type} is not equal to lookup field (${lookupFieldRaw.type})`
      );
    }

    const lookupFieldOptions = JSON.parse(lookupFieldRaw.options as string) as object | null;
    const formatting =
      (field.options as INumberFieldOptions)?.formatting ??
      getDefaultFormatting(lookupFieldRaw.cellValueType as CellValueType);
    const options = lookupFieldOptions
      ? formatting
        ? { ...lookupFieldOptions, formatting }
        : lookupFieldOptions
      : undefined;

    return {
      ...field,
      name: field.name ?? `${lookupFieldRaw.name} (from ${linkFieldRaw.name})`,
      options,
      lookupOptions,
    };
  }

  private async prepareFormulaField(field: IFieldRo, batchFieldRos?: IFieldRo[]) {
    let fieldIds;
    try {
      fieldIds = FormulaFieldDto.getReferenceFieldIds(
        (field.options as IFormulaFieldOptions).expression
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      throw new BadRequestException('expression parse error');
    }

    const fieldRaws = await this.prismaService.field.findMany({
      where: { id: { in: fieldIds } },
    });

    const fields = fieldRaws.map((fieldRaw) => createFieldInstanceByRaw(fieldRaw));
    const batchFields = batchFieldRos?.map((fieldRo) => createFieldInstanceByRo(fieldRo));
    const fieldMap = keyBy(fields.concat(batchFields || []), 'id');

    if (fieldIds.find((id) => !fieldMap[id])) {
      throw new BadRequestException(`formula field reference ${fieldIds.join()} not found`);
    }

    const { cellValueType, isMultipleCellValue } = FormulaFieldDto.getParsedValueType(
      (field.options as IFormulaFieldOptions).expression,
      fieldMap
    );

    const formatting =
      (field.options as IFormulaFieldOptions)?.formatting ?? getDefaultFormatting(cellValueType);
    const options = formatting ? { ...field.options, formatting } : field.options;

    return {
      ...field,
      options,
      cellValueType,
      isMultipleCellValue,
    };
  }

  private async prepareRollupField(field: IFieldRo, batchFieldRos?: IFieldRo[]) {
    const { lookupOptions, linkFieldRaw, lookupFieldRaw } = await this.prepareLookupOptions(
      field,
      batchFieldRos
    );
    const options = field.options as IRollupFieldOptions;

    if (!options) {
      throw new BadRequestException('rollup field options is required');
    }

    let valueType;
    try {
      valueType = RollupFieldDto.getParsedValueType(options.expression);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      throw new BadRequestException(e.message);
    }

    const { cellValueType, isMultipleCellValue } = valueType;

    const formatting = options.formatting ?? getDefaultFormatting(cellValueType);
    const fulfilledOptions = formatting ? { ...field.options, formatting } : field.options;

    return {
      ...field,
      name: field.name ?? `${lookupFieldRaw.name} Rollup (from ${linkFieldRaw.name})`,
      options: fulfilledOptions,
      lookupOptions,
      cellValueType,
      isMultipleCellValue,
    };
  }

  async prepareField(fieldRo: IFieldRo, batchFieldRos?: IFieldRo[]): Promise<IFieldRo> {
    if (fieldRo.isLookup) {
      return await this.prepareLookupField(fieldRo, batchFieldRos);
    }

    if (fieldRo.type === FieldType.Rollup) {
      return await this.prepareRollupField(fieldRo, batchFieldRos);
    }

    if (fieldRo.type == FieldType.Link) {
      return await this.prepareLinkField(fieldRo);
    }

    if (fieldRo.type == FieldType.Formula) {
      return await this.prepareFormulaField(fieldRo, batchFieldRos);
    }

    return fieldRo;
  }

  private async generateSymmetricField(
    prisma: Prisma.TransactionClient,
    tableId: string,
    field: LinkFieldDto
  ) {
    const { name: tableName } = await prisma.tableMeta.findUniqueOrThrow({
      where: { id: tableId },
      select: { name: true },
    });

    // lookup field id is the primary field of the table to which it is linked
    const { id: lookupFieldId } = await prisma.field.findFirstOrThrow({
      where: { tableId, isPrimary: true },
      select: { id: true },
    });

    const relationship = RelationshipRevert[field.options.relationship];
    return createFieldInstanceByRo({
      id: field.options.symmetricFieldId,
      name: tableName,
      type: FieldType.Link,
      options: {
        relationship,
        foreignTableId: tableId,
        lookupFieldId,
        dbForeignKeyName: field.options.dbForeignKeyName,
        symmetricFieldId: field.id,
      },
    }) as LinkFieldDto;
  }

  private async createForeignKeyField(
    prisma: Prisma.TransactionClient,
    tableId: string, // tableId for current field belongs to
    field: LinkFieldDto
  ) {
    if (field.options.relationship !== Relationship.ManyOne) {
      throw new Error('only many-one relationship should create foreign key field');
    }

    const dbTableName = await this.getDbTableName(prisma, tableId);
    const alterTableQuery = this.knex.schema
      .alterTable(dbTableName, (table) => {
        table.string(field.options.dbForeignKeyName).unique().nullable();
      })
      .toQuery();
    await prisma.$executeRawUnsafe(alterTableQuery);
  }

  async supplementByCreate(prisma: Prisma.TransactionClient, tableId: string, field: LinkFieldDto) {
    if (field.type !== FieldType.Link) {
      throw new Error('only link field need to create supplement field');
    }

    const foreignTableId = field.options.foreignTableId;
    const symmetricField = await this.generateSymmetricField(prisma, tableId, field);

    if (symmetricField.options.relationship === Relationship.ManyOne) {
      await this.createForeignKeyField(prisma, foreignTableId, symmetricField);
    }

    if (field.options.relationship === Relationship.ManyOne) {
      await this.createForeignKeyField(prisma, tableId, field);
    }

    return symmetricField;
  }

  async createReference(prisma: Prisma.TransactionClient, field: IFieldInstance) {
    if (field.isLookup) {
      return await this.createLookupReference(prisma, field);
    }

    switch (field.type) {
      case FieldType.Formula:
        return await this.createFormulaReference(prisma, field);
      case FieldType.Rollup:
        // rollup use same reference logic as lookup
        return await this.createLookupReference(prisma, field);
      case FieldType.Link:
        return await this.createLinkReference(prisma, field);
      default:
        break;
    }
  }

  private async createLookupReference(prisma: Prisma.TransactionClient, field: IFieldInstance) {
    const toFieldId = field.id;
    if (!field.lookupOptions) {
      throw new Error('lookupOptions is required');
    }
    const { lookupFieldId } = field.lookupOptions;

    await prisma.reference.create({
      data: {
        fromFieldId: lookupFieldId,
        toFieldId,
      },
    });
  }

  private async createLinkReference(prisma: Prisma.TransactionClient, field: LinkFieldDto) {
    const toFieldId = field.id;
    const fromFieldId = field.options.lookupFieldId;

    await prisma.reference.create({
      data: {
        fromFieldId,
        toFieldId,
      },
    });
  }

  private async createFormulaReference(prisma: Prisma.TransactionClient, field: FormulaFieldDto) {
    const fieldIds = field.getReferenceFieldIds();
    const toFieldId = field.id;

    for (const fromFieldId of fieldIds) {
      await prisma.reference.create({
        data: {
          fromFieldId,
          toFieldId,
        },
      });
    }
  }
}
