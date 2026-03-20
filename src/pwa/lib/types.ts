// All TypeScript interfaces from SPECS.md Section 1

export interface Product {
  id?: number;
  barcode: string;
  invoiceCode: string;
  itemNumber: string;
  name: string;
  smartRetailName?: string;
  imageUrl?: string;
  category: "fresh" | "flavoured" | "uht" | "specialty"
          | "spirits" | "wine" | "beer" | "cider" | "rtd" | "non_alc";
  department?: "dairy" | "liquor" | "general";   // defaults to 'dairy' for existing products
  isGstBearing: boolean;
  active: boolean;
  orderUnit: string;
  unitsPerOrder: number;
  minStockLevel: number;
  maxStockLevel?: number;
  defaultOrderQty: number;
  targetDaysOfStock: number;
  lactalisCostPrice: number;
  metcashCostPrice?: number;
  sellPrice: number;
  supplier?: string;                               // e.g. 'lactalis', 'alm', 'metcash'
  abv?: number          // Alcohol By Volume % (e.g. 4.5)
  bottleSize?: number   // Container size in ml (e.g. 700, 750, 1125)
  notes?: string        // Free-text field for staff notes on any product
  orderFrequency: "every" | "most" | "some" | "occasional";
  createdAt: Date;
  updatedAt: Date;
}

export interface StockSnapshot {
  id?: number;
  productId: number;
  barcode: string;
  qoh: number;
  importedAt: Date;
  source: "item_maintenance" | "item_stock_report";
  importBatchId: string;
}

export interface DeliverySlot {
  id?: number;
  deliveryDate: string;
  orderCutoffDate: string;
  orderCutoffTime: string;
  status: "upcoming" | "ordered" | "delivered" | "missed";
  orderId?: number;
  scrapedAt?: Date;
  manualEntry: boolean;
}

export interface Order {
  id?: number;
  deliveryDate: string;
  createdAt: Date;
  approvedAt?: Date;
  submittedAt?: Date;
  status: "draft" | "approved" | "submitted" | "delivered" | "cancelled";
  totalCostEstimate: number;
  totalCostActual?: number;
  lactalisOrderNumber?: string;
  invoiceNumber?: string;
  notes?: string;
  portalSource?: boolean;
  portalStatus?: string;
  portalRefNumber?: string;
}

export interface OrderLine {
  id?: number;
  orderId: number;
  productId: number;
  itemNumber: string;
  productName: string;
  suggestedQty: number;
  approvedQty: number;
  deliveredQty?: number;
  unitPrice: number;
  actualUnitPrice?: number;
  lineTotal: number;
}

export interface InvoiceRecord {
  id?: number;
  documentNumber: string;
  documentType: "invoice" | "credit_note" | "adjustment";
  dateOrdered: string;
  invoiceDate: string;
  totalAmount: number;
  parsedAt: Date;
  rawText?: string;
}

export interface InvoiceLine {
  id?: number;
  invoiceRecordId: number;
  deliveryNoteNumber: string;
  deliveryDate: string;
  purchaseOrderNumber: string;
  productCode: string;
  productName: string;
  quantity: number;
  unitType: "EA" | "CTN";
  listPrice: number;
  lineDiscount?: number;
  containerScheme?: number;
  gst?: number;
  extendedPrice: number;
  pricePerItem: number;
}

export interface PriceRecord {
  id?: number;
  productId: number;
  invoiceCode: string;
  effectiveDate: string;
  costPrice: number;
  source: "invoice" | "smart_retail" | "portal";
}

export interface ExpiryBatch {
  id?: number;
  productId: number;
  productName: string;
  orderId?: number;
  quantity: number;       // units currently tracked (decreases on write-off)
  expiryDate: string;     // YYYY-MM-DD
  receivedDate: string;   // YYYY-MM-DD
  status: "active" | "wasted";
}

export interface WasteEntry {
  id?: number;
  productId: number;
  productName: string;
  expiryBatchId?: number;
  quantity: number;
  wastedDate: string;     // YYYY-MM-DD
  reason: "expired" | "damaged" | "other";
  notes?: string;
}

export interface ClaimRecord {
  id?: number;
  productId?: number;
  productName: string;
  claimType: "damaged" | "short_delivery" | "wrong_product" | "out_of_date";
  quantity: number;
  invoiceRef?: string;
  orderId?: number;
  description: string;
  emailSentAt?: string;   // YYYY-MM-DD
  createdAt: string;      // YYYY-MM-DD
}

export interface PhotoRecord {
  id?: number;
  orderId?: number;
  claimId?: number;
  productId?: number;
  photoType: "invoice" | "claim_evidence" | "delivery_receipt";
  base64: string;
  capturedAt: string;     // ISO datetime
  notes?: string;
}

export interface ScrapedOrder {
  orderNumber: string;
  createdAt: string | null;     // ISO datetime
  deliveryDate: string | null;  // YYYY-MM-DD
  orderStatus: string | null;
  refNumber?: string | null;
  totalQty: number;
  total: number;
  onlineOrder?: boolean | null;
  lineItems?: Array<{
    itemNumber: string | null;
    productName: string;
    qty: number;
    price: number;
    lineTotal: number;
  }>;
}

export interface GmailSyncRecord {
  id?: number;
  messageId: string;      // Gmail message ID (unique index)
  syncedAt: Date;
  parsed: boolean;
  subject: string;
  orderNumber?: string;
  parseError?: string;
}

export interface SalesRecord {
  id?: number;
  productId?: number;         // FK if matched to a product
  barcode: string;            // raw barcode/PLU from JARVISmart
  date: string;               // YYYY-MM-DD (daily aggregate)
  qtySold: number;            // units sold that day
  salesValue: number;         // revenue (ex-GST)
  cogs: number;               // cost of goods sold
  department?: string;        // raw dept from Smart Retail
  importBatchId: string;
  importedAt: Date;
}

export interface Promotion {
  id?: number
  productId: number
  productName: string   // denormalized (avoids joins on display)
  barcode: string       // denormalized (for salesRecords velocity lookup)
  startDate: string     // YYYY-MM-DD
  endDate: string       // YYYY-MM-DD
  promoPrice: number
  normalPrice: number
  promoType: 'price_reduction' | 'multibuy' | 'special'
  multibuyQty?: number    // e.g. 3  (buy 3…)
  multibuyPrice?: number  // e.g. 10 (…for $10)
  notes?: string
  createdAt: Date
}

// Computed at query time — not stored in DB
export interface StockPerformance {
  productId: number;
  avgDailySales: number;
  dataSource: "pos_scan" | "invoice" | "default";
  stockTurnRate: number;      // annualised inventory turns
  gmroi: number;              // gross margin return on inventory investment
  daysOfStock: number;        // QOH / avgDailySales
  velocityTrend: number;      // % change: last 4w vs prev 4w
  shrinkage?: number;         // units unexplained by deliveries - sales
  abcClass: "A" | "B" | "C" | "D";   // D = dead stock
  lastSaleDate?: string;      // YYYY-MM-DD of most recent scan
}
