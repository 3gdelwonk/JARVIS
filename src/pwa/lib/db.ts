import Dexie, { type Table } from 'dexie'
import type {
  Product,
  StockSnapshot,
  DeliverySlot,
  Order,
  OrderLine,
  InvoiceRecord,
  InvoiceLine,
  PriceRecord,
  ExpiryBatch,
  WasteEntry,
  ClaimRecord,
} from './types'
import { SEED_PRODUCTS } from '../data/seedProducts'

export class MilkManagerDB extends Dexie {
  products!: Table<Product>
  stockSnapshots!: Table<StockSnapshot>
  deliverySlots!: Table<DeliverySlot>
  orders!: Table<Order>
  orderLines!: Table<OrderLine>
  invoiceRecords!: Table<InvoiceRecord>
  invoiceLines!: Table<InvoiceLine>
  priceHistory!: Table<PriceRecord>
  expiryBatches!: Table<ExpiryBatch>
  wasteLog!: Table<WasteEntry>
  claimRecords!: Table<ClaimRecord>

  constructor() {
    super('MilkManagerDB')
    // v1 — kept for upgrade path (schema only, no data migration needed)
    this.version(1).stores({
      products: '++id, &barcode, &invoiceCode, itemNumber, category, active',
      stockSnapshots: '++id, [productId+importedAt], importBatchId',
      deliverySlots: '++id, deliveryDate, status, [orderCutoffDate+orderCutoffTime]',
      orders: '++id, status, deliveryDate, createdAt',
      orderLines: '++id, orderId, productId',
      invoiceRecords: '++id, &documentNumber, invoiceDate',
      invoiceLines: '++id, invoiceRecordId, productCode, deliveryDate',
      priceHistory: '++id, [productId+effectiveDate], invoiceCode',
    })
    // v2 — barcode no longer unique (several products have empty barcode string)
    this.version(2).stores({
      products: '++id, barcode, &invoiceCode, itemNumber, category, active',
    })
    // v3 — expiry tracking tables
    this.version(3).stores({
      expiryBatches: '++id, productId, expiryDate, status, receivedDate',
      wasteLog: '++id, productId, wastedDate, expiryBatchId',
    })
    // v4 — claim records
    this.version(4).stores({
      claimRecords: '++id, productId, claimType, createdAt',
    })
  }
}

export const db = new MilkManagerDB()

export async function clearAllData(): Promise<void> {
  await db.transaction('rw', [
    db.invoiceRecords, db.invoiceLines, db.priceHistory,
    db.stockSnapshots, db.orders, db.orderLines,
    db.expiryBatches, db.wasteLog, db.products, db.claimRecords,
  ], async () => {
    await Promise.all([
      db.invoiceRecords.clear(),
      db.invoiceLines.clear(),
      db.priceHistory.clear(),
      db.stockSnapshots.clear(),
      db.orders.clear(),
      db.orderLines.clear(),
      db.expiryBatches.clear(),
      db.wasteLog.clear(),
      db.products.clear(),
      db.claimRecords.clear(),
    ])
  })
  // Re-seed the product catalogue
  await seedDatabase()
}

export async function seedDatabase(): Promise<void> {
  const count = await db.products.count()
  if (count >= SEED_PRODUCTS.length) return

  const products: Product[] = SEED_PRODUCTS.map((p) => ({
    barcode: p.barcode,
    invoiceCode: p.invoiceCode,
    itemNumber: p.itemNumber,
    name: p.name,
    category: p.category === 'uht' ? 'uht' : p.category,
    isGstBearing: p.isGstBearing,
    active: true,
    orderUnit: p.orderUnit,
    unitsPerOrder: p.unitsPerOrder,
    minStockLevel: 0,
    defaultOrderQty: p.avgQtyPerDelivery,
    targetDaysOfStock: 4,
    lactalisCostPrice: p.costPrice,
    metcashCostPrice: p.metcashCost > 0 ? p.metcashCost : undefined,
    sellPrice: p.sellPrice,
    orderFrequency: p.orderFrequency,
    createdAt: new Date(),
    updatedAt: new Date(),
  }))

  await db.products.bulkAdd(products)
}
