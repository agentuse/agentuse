/**
 * Zod schemas for store validation
 */

import { z } from 'zod';

/**
 * Schema for a store item
 */
export const StoreItemSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  type: z.string().optional(),
  status: z.string().optional(),
  title: z.string().optional(),
  createdBy: z.string().optional(),
  data: z.record(z.unknown()),
  parentId: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

/**
 * Schema for creating a store item
 */
export const StoreCreateOptionsSchema = z.object({
  type: z.string().optional(),
  title: z.string().optional(),
  status: z.string().optional(),
  data: z.record(z.unknown()),
  parentId: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

/**
 * Schema for updating a store item
 */
export const StoreUpdateOptionsSchema = z.object({
  type: z.string().optional(),
  title: z.string().optional(),
  status: z.string().optional(),
  data: z.record(z.unknown()).optional(),
  parentId: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

/**
 * Schema for listing store items
 */
export const StoreListOptionsSchema = z.object({
  type: z.string().optional(),
  status: z.string().optional(),
  parentId: z.string().optional(),
  tag: z.string().optional(),
  limit: z.number().positive().optional(),
  offset: z.number().nonnegative().optional(),
});

/**
 * Schema for the store file
 */
export const StoreFileSchema = z.object({
  version: z.literal(1),
  items: z.array(StoreItemSchema),
});

/**
 * Schema for store configuration in agent YAML
 */
export const StoreConfigSchema = z.union([
  z.literal(true),
  z.string().min(1),
]);
