import { Body, Injectable, Query, type PipeTransform, applyDecorators } from '@nestjs/common';
import { ApiBody, ApiQuery } from '@nestjs/swagger';
import { z, type ZodType } from 'zod';
import { AppError } from './errors.js';

/** Validates (and strips unknown keys from) input with a Zod schema. */
@Injectable()
export class ZodValidationPipe<T extends ZodType> implements PipeTransform {
  constructor(private readonly schema: T) {}

  transform(value: unknown): z.output<T> {
    const parsed = this.schema.safeParse(value);
    if (!parsed.success) {
      throw new AppError(
        'VALIDATION_FAILED',
        400,
        'Some fields are missing or invalid.',
        parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      );
    }
    return parsed.data;
  }
}

/** JSON Schema (OpenAPI 3.0 flavour) for Swagger, generated from the Zod schema. */
export function toOpenApiSchema(schema: ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { target: 'openapi-3.0', io: 'input', unrepresentable: 'any' }) as Record<
    string,
    unknown
  >;
  delete json.$schema;
  return json;
}

/** Request body validated by `schema` (use with @ApiZodBody on the method). */
export const ZodBody = (schema: ZodType) => Body(new ZodValidationPipe(schema));
export const ZodQuery = (schema: ZodType) => Query(new ZodValidationPipe(schema));

export const ApiZodBody = (schema: ZodType, description?: string) =>
  ApiBody({ schema: toOpenApiSchema(schema), description });

/** Documents each property of an object schema as a query parameter. */
export function ApiZodQuery(schema: z.ZodObject) {
  const decorators = Object.entries(schema.shape).map(([name, field]) =>
    ApiQuery({
      name,
      required: !(field as ZodType).safeParse(undefined).success,
      schema: toOpenApiSchema(field as ZodType),
    }),
  );
  return applyDecorators(...decorators);
}
