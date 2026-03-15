// All TypeScript interfaces from SPECS.md Section 1

export interface Product {
  id?: number;
  barcode: string;
  invoiceCode: string;
  itemNumber: string;
  name: string;
  smartRetailName?: string;
  imageUrl?: string;
  category: "fresh" | "flavoured" | "uht" | "specialty";
  isGstBearing: boolean;
  active: boolean;
  orderUnit: string;
  unitsPerOrder: number;
  minStockLevel: number;
  defaultOrderQty: number;
  targetDaysOfStock: number;
  lactalisCostPrice: number;
  metcashCostPrice?: number;
  sellPrice: number;
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
