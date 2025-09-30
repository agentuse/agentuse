import { z } from 'zod';

/**
 * Convert Zod schema to JSON Schema format required by MCP
 * Supports common Zod types and nested structures
 */
export function zodToJsonSchema(schema: z.ZodType<any, any, any>): any {
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape;
    const properties: Record<string, any> = {};
    const required: string[] = [];

    for (const [key, value] of Object.entries(shape)) {
      const zodField = value as z.ZodType<any, any, any>;
      properties[key] = zodToJsonSchema(zodField);

      // Check if field is required
      if (!zodField.isOptional()) {
        required.push(key);
      }
    }

    return {
      type: 'object',
      properties,
      required: required.length > 0 ? required : undefined
    };
  } else if (schema instanceof z.ZodString) {
    const result: any = { type: 'string' };
    if (schema.description) {
      result.description = schema.description;
    }
    return result;
  } else if (schema instanceof z.ZodNumber) {
    const result: any = { type: 'number' };
    if (schema.description) {
      result.description = schema.description;
    }
    return result;
  } else if (schema instanceof z.ZodBoolean) {
    const result: any = { type: 'boolean' };
    if (schema.description) {
      result.description = schema.description;
    }
    return result;
  } else if (schema instanceof z.ZodArray) {
    return {
      type: 'array',
      items: zodToJsonSchema(schema.element)
    };
  } else if (schema instanceof z.ZodEnum) {
    const values = schema.options;
    return {
      type: 'string',
      enum: values
    };
  } else if (schema instanceof z.ZodOptional) {
    return zodToJsonSchema(schema.unwrap());
  } else if (schema instanceof z.ZodDefault) {
    const baseSchema = zodToJsonSchema(schema.removeDefault());
    baseSchema.default = schema._def.defaultValue();
    return baseSchema;
  } else if (schema instanceof z.ZodUnion) {
    const options = schema.options as z.ZodType<any, any, any>[];
    return {
      oneOf: options.map(opt => zodToJsonSchema(opt))
    };
  } else if (schema instanceof z.ZodRecord) {
    return {
      type: 'object',
      additionalProperties: zodToJsonSchema(schema.element)
    };
  } else {
    // Fallback for unknown types
    return { type: 'object' };
  }
}