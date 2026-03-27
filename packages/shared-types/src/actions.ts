import { z } from 'zod';

// ── Outbound: Bridge → Agent (Events) ─────────────────────────────────────────

export const BridgeEventTypeSchema = z.enum([
  'GAME_STATE_UPDATE',
  'DAY_STARTED',
  'DAY_ENDED',
  'DIALOG_OPENED',
  'CHEST_OPENED',
  'BUNDLE_UPDATED',
  'GAME_PAUSED',
  'GAME_RESUMED',
]);
export type BridgeEventType = z.infer<typeof BridgeEventTypeSchema>;

// ── Inbound: Agent → Bridge (Actions) ─────────────────────────────────────────

export const GameActionTypeSchema = z.enum([
  'ACTION_MOVE',
  'ACTION_USE_TOOL',
  'ACTION_EQUIP_TOOL',
  'ACTION_PICKUP_ITEM',
  'ACTION_DROP_ITEM',
  'ACTION_SELECT_DIALOG',
  'ACTION_OPEN_MENU',
  'ACTION_BUY_ITEM',
  'ACTION_SELL_ITEM',
  'ACTION_SLEEP',
  'ACTION_PLACE_ITEM',
]);
export type GameActionType = z.infer<typeof GameActionTypeSchema>;

// ── Action Payloads ───────────────────────────────────────────────────────────

export const MoveActionSchema = z.object({
  type: z.literal('ACTION_MOVE'),
  payload: z.object({
    targetX: z.number().int(),
    targetY: z.number().int(),
    map: z.string(),
  }),
});
export type MoveAction = z.infer<typeof MoveActionSchema>;

export const UseToolActionSchema = z.object({
  type: z.literal('ACTION_USE_TOOL'),
  payload: z.object({
    x: z.number().int(),
    y: z.number().int(),
  }),
});
export type UseToolAction = z.infer<typeof UseToolActionSchema>;

export const EquipToolActionSchema = z.object({
  type: z.literal('ACTION_EQUIP_TOOL'),
  payload: z.object({
    tool: z.string(),
  }),
});
export type EquipToolAction = z.infer<typeof EquipToolActionSchema>;

export const PickupItemActionSchema = z.object({
  type: z.literal('ACTION_PICKUP_ITEM'),
  payload: z.object({ itemId: z.string() }),
});
export type PickupItemAction = z.infer<typeof PickupItemActionSchema>;

export const DropItemActionSchema = z.object({
  type: z.literal('ACTION_DROP_ITEM'),
  payload: z.object({ slot: z.number().int().min(0) }),
});
export type DropItemAction = z.infer<typeof DropItemActionSchema>;

export const SelectDialogActionSchema = z.object({
  type: z.literal('ACTION_SELECT_DIALOG'),
  payload: z.object({ optionIndex: z.number().int().min(0) }),
});
export type SelectDialogAction = z.infer<typeof SelectDialogActionSchema>;

export const BuyItemActionSchema = z.object({
  type: z.literal('ACTION_BUY_ITEM'),
  payload: z.object({
    shopId: z.string(),
    itemId: z.string(),
    quantity: z.number().int().min(1),
  }),
});
export type BuyItemAction = z.infer<typeof BuyItemActionSchema>;

export const SellItemActionSchema = z.object({
  type: z.literal('ACTION_SELL_ITEM'),
  payload: z.object({
    itemId: z.string(),
    quantity: z.number().int().min(1),
  }),
});
export type SellItemAction = z.infer<typeof SellItemActionSchema>;

export const SleepActionSchema = z.object({
  type: z.literal('ACTION_SLEEP'),
});
export type SleepAction = z.infer<typeof SleepActionSchema>;

export const OpenMenuActionSchema = z.object({
  type: z.literal('ACTION_OPEN_MENU'),
  payload: z.object({ menuId: z.string() }),
});
export type OpenMenuAction = z.infer<typeof OpenMenuActionSchema>;

export const PlaceItemActionSchema = z.object({
  type: z.literal('ACTION_PLACE_ITEM'),
  payload: z.object({
    itemId: z.string(),
    x: z.number().int(),
    y: z.number().int(),
  }),
});
export type PlaceItemAction = z.infer<typeof PlaceItemActionSchema>;

// ── Union ─────────────────────────────────────────────────────────────────────

export const GameActionSchema = z.discriminatedUnion('type', [
  MoveActionSchema,
  UseToolActionSchema,
  EquipToolActionSchema,
  PickupItemActionSchema,
  DropItemActionSchema,
  SelectDialogActionSchema,
  BuyItemActionSchema,
  SellItemActionSchema,
  SleepActionSchema,
  OpenMenuActionSchema,
  PlaceItemActionSchema,
]);
export type GameAction = z.infer<typeof GameActionSchema>;

// ── WebSocket Message Wrapper ─────────────────────────────────────────────────

export const WebSocketMessageSchema = z.object({
  messageId: z.string().uuid(),
  timestamp: z.string().datetime(),
  type: z.string(),
  payload: z.unknown(),
});
export type WebSocketMessage = z.infer<typeof WebSocketMessageSchema>;
