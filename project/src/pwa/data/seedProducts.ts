/**
 * seedProducts.ts — Complete product catalogue
 * 
 * VERIFIED: Item numbers are invoice product codes stripped of leading zeros.
 * Tested on live Lactalis Quick Order portal: 801 → "Pauls Milk Rev Low Fat 2L" ✅
 * 
 * Sources: 16 Lactalis invoices (Nov 2025 – Mar 2026) + Smart Retail Item Maintenance export
 */

export interface SeedProduct {
  itemNumber: string;             // Quick Order item number (invoice code, no leading zeros)
  invoiceCode: string;            // 8-digit code as it appears on invoices
  barcode: string;                // EAN-13 from Smart Retail (empty if unmapped)
  name: string;                   // Canonical name from invoices
  category: "fresh" | "flavoured" | "uht";
  isGstBearing: boolean;          // true = flavoured/UHT milk (10% GST)
  orderUnit: string;              // From portal Favourites (e.g. "Crate of 9")
  unitsPerOrder: number;          // Units in one order unit
  costPrice: number;              // Most recent Price Per Item from invoice (ex-GST)
  sellPrice: number;              // From Smart Retail (0 if unknown)
  metcashCost: number;            // Metcash cost from Smart Retail (0 if N/A)
  avgQtyPerDelivery: number;      // Median from 16 invoices
  orderFrequency: "every" | "most" | "some" | "occasional";
}

export const SEED_PRODUCTS: SeedProduct[] = [
  // ═══════════════════════════════════════════════════
  // FRESH MILK — GST-free
  // ═══════════════════════════════════════════════════
  {
    itemNumber: "19100", invoiceCode: "00019100",
    barcode: "9310036040385", name: "Mooloo Mountain Full Cream Milk 2L",
    category: "fresh", isGstBearing: false,
    orderUnit: "Crate of 9", unitsPerOrder: 9,
    costPrice: 3.16, sellPrice: 4.69, metcashCost: 3.16,
    avgQtyPerDelivery: 18, orderFrequency: "every"
  },
  {
    itemNumber: "40248", invoiceCode: "00040248",
    barcode: "9310036040248", name: "Mooloo Mountain Lite Milk 2L",
    category: "fresh", isGstBearing: false,
    orderUnit: "Crate of 9", unitsPerOrder: 9,
    costPrice: 3.27, sellPrice: 4.50, metcashCost: 3.13,
    avgQtyPerDelivery: 10, orderFrequency: "every"
  },
  {
    itemNumber: "18532", invoiceCode: "00018532",
    barcode: "9310036040521", name: "Mooloo Mountain Full Cream Milk 3L",
    category: "fresh", isGstBearing: false,
    orderUnit: "Crate of 6", unitsPerOrder: 6,
    costPrice: 4.74, sellPrice: 6.30, metcashCost: 4.95,
    avgQtyPerDelivery: 7, orderFrequency: "every"
  },
  {
    itemNumber: "39482", invoiceCode: "00039482",
    barcode: "9310036039488", name: "Pauls Smarter White 2% Fat Milk 2L",
    category: "fresh", isGstBearing: false,
    orderUnit: "Crate of 9", unitsPerOrder: 9,
    costPrice: 4.33, sellPrice: 5.69, metcashCost: 4.30,
    avgQtyPerDelivery: 4, orderFrequency: "every"
  },
  {
    itemNumber: "39466", invoiceCode: "00039466",
    barcode: "9310036039471", name: "Pauls Smarter White 2% Fat Milk 1L",
    category: "fresh", isGstBearing: false,
    orderUnit: "Crate of 12", unitsPerOrder: 12,
    costPrice: 2.41, sellPrice: 3.45, metcashCost: 2.40,
    avgQtyPerDelivery: 4, orderFrequency: "every"
  },
  {
    itemNumber: "801", invoiceCode: "00000801",
    barcode: "9310036000808", name: "Rev Low Fat Milk 2L",
    category: "fresh", isGstBearing: false,
    orderUnit: "Crate of 9", unitsPerOrder: 9,
    costPrice: 4.33, sellPrice: 5.55, metcashCost: 4.33,
    avgQtyPerDelivery: 3, orderFrequency: "every"
  },
  {
    itemNumber: "909", invoiceCode: "00000909",
    barcode: "9310036000907", name: "Skinny Milk BTL 2L",
    category: "fresh", isGstBearing: false,
    orderUnit: "Crate of 9", unitsPerOrder: 9,
    costPrice: 4.32, sellPrice: 6.25, metcashCost: 4.30,
    avgQtyPerDelivery: 3, orderFrequency: "every"
  },
  {
    itemNumber: "48186", invoiceCode: "00048186",
    barcode: "9310036048183", name: "Pauls Farmhouse Gold Milk 1.5L",
    category: "fresh", isGstBearing: false,
    orderUnit: "Crate of 9", unitsPerOrder: 9,
    costPrice: 3.61, sellPrice: 4.75, metcashCost: 3.61,
    avgQtyPerDelivery: 3, orderFrequency: "every"
  },
  {
    itemNumber: "70120", invoiceCode: "00070120",
    barcode: "9310036048985", name: "Pauls Zymil Full Cream Milk 2L",
    category: "fresh", isGstBearing: false,
    orderUnit: "Crate of 9", unitsPerOrder: 9,
    costPrice: 4.98, sellPrice: 6.79, metcashCost: 4.60,
    avgQtyPerDelivery: 3, orderFrequency: "every"
  },
  {
    itemNumber: "74930", invoiceCode: "00074930",
    barcode: "9310036063520", name: "Pauls Zymil Low Fat Milk 2L",
    category: "fresh", isGstBearing: false,
    orderUnit: "Crate of 9", unitsPerOrder: 9,
    costPrice: 4.98, sellPrice: 6.79, metcashCost: 4.60,
    avgQtyPerDelivery: 3, orderFrequency: "most"
  },
  {
    itemNumber: "22444", invoiceCode: "00022444",
    barcode: "9310036039235", name: "Pauls Zymil Full Cream Milk 6x1L",
    category: "fresh", isGstBearing: false,
    orderUnit: "Carton of 6", unitsPerOrder: 6,
    costPrice: 2.90, sellPrice: 4.35, metcashCost: 2.64,
    avgQtyPerDelivery: 4, orderFrequency: "every"
  },
  {
    itemNumber: "16741", invoiceCode: "00016741",
    barcode: "9310036037941", name: "Pauls Zymil Low Fat Milk 6X1L",
    category: "fresh", isGstBearing: false,
    orderUnit: "Carton of 6", unitsPerOrder: 6,
    costPrice: 2.90, sellPrice: 4.35, metcashCost: 2.64,
    avgQtyPerDelivery: 3, orderFrequency: "most"
  },
  {
    itemNumber: "30720", invoiceCode: "00030720",
    barcode: "9310036034872", name: "Pauls Zymil Skim White Milk 6x1L",
    category: "fresh", isGstBearing: false,
    orderUnit: "Carton of 6", unitsPerOrder: 6,
    costPrice: 2.90, sellPrice: 4.35, metcashCost: 2.64,
    avgQtyPerDelivery: 2, orderFrequency: "most"
  },
  {
    itemNumber: "1003", invoiceCode: "00001003",
    barcode: "9310036116493", name: "Pauls Full Cream Milk BTL 2L",
    category: "fresh", isGstBearing: false,
    orderUnit: "Crate of 9", unitsPerOrder: 9,
    costPrice: 3.71, sellPrice: 5.99, metcashCost: 4.53,
    avgQtyPerDelivery: 3, orderFrequency: "most"
  },
  {
    itemNumber: "5995", invoiceCode: "00005995",
    barcode: "9310036005995", name: "Pauls Full Cream Milk CTN 1L",
    category: "fresh", isGstBearing: false,
    orderUnit: "Crate of 16", unitsPerOrder: 16,
    costPrice: 2.41, sellPrice: 2.95, metcashCost: 2.32,
    avgQtyPerDelivery: 6, orderFrequency: "most"
  },
  {
    itemNumber: "5987", invoiceCode: "00005987",
    barcode: "9310036005988", name: "Pauls Full Cream CTN 600ML",
    category: "fresh", isGstBearing: false,
    orderUnit: "Crate of 28", unitsPerOrder: 28,
    costPrice: 1.51, sellPrice: 2.65, metcashCost: 1.44,
    avgQtyPerDelivery: 5, orderFrequency: "most"
  },
  {
    itemNumber: "851", invoiceCode: "00000851",
    barcode: "9310036000853", name: "Rev Low Fat Milk CTN 1L",
    category: "fresh", isGstBearing: false,
    orderUnit: "Crate of 16", unitsPerOrder: 16,
    costPrice: 2.46, sellPrice: 3.50, metcashCost: 2.04,
    avgQtyPerDelivery: 3, orderFrequency: "most"
  },
  {
    itemNumber: "14584", invoiceCode: "00014584",
    barcode: "9310036014584", name: "Physical Low Fat Milk CTN 1L",
    category: "fresh", isGstBearing: false,
    orderUnit: "Crate of 16", unitsPerOrder: 16,
    costPrice: 2.46, sellPrice: 3.75, metcashCost: 2.36,
    avgQtyPerDelivery: 4, orderFrequency: "most"
  },
  {
    itemNumber: "14592", invoiceCode: "00014592",
    barcode: "9310036014591", name: "Physical Low Fat Milk 2L",
    category: "fresh", isGstBearing: false,
    orderUnit: "Crate of 9", unitsPerOrder: 9,
    costPrice: 4.33, sellPrice: 6.10, metcashCost: 4.60,
    avgQtyPerDelivery: 4, orderFrequency: "most"
  },
  {
    itemNumber: "47300", invoiceCode: "00047300",
    barcode: "9310036047308", name: "Pauls Farmhouse Gold Milk 750ML",
    category: "fresh", isGstBearing: false,
    orderUnit: "Crate of 12", unitsPerOrder: 12,
    costPrice: 2.12, sellPrice: 2.95, metcashCost: 2.03,
    avgQtyPerDelivery: 4, orderFrequency: "most"
  },
  {
    itemNumber: "72019", invoiceCode: "00072019",
    barcode: "9310036045434", name: "Pauls FHG Organic F/C 1.5L",
    category: "fresh", isGstBearing: false,
    orderUnit: "Crate of 9", unitsPerOrder: 9,
    costPrice: 4.80, sellPrice: 5.90, metcashCost: 4.59,
    avgQtyPerDelivery: 2, orderFrequency: "most"
  },
  {
    itemNumber: "46703", invoiceCode: "00046703",
    barcode: "9310036046707", name: "Pauls Farmhouse Gold Unhomo Milk 1.5L",
    category: "fresh", isGstBearing: false,
    orderUnit: "Crate of 9", unitsPerOrder: 9,
    costPrice: 3.61, sellPrice: 4.90, metcashCost: 3.50,
    avgQtyPerDelivery: 2, orderFrequency: "some"
  },
  {
    itemNumber: "73483", invoiceCode: "00073483",
    barcode: "9310036073482", name: "Pauls Protein Plus Low Fat Milk 2L",
    category: "fresh", isGstBearing: false,
    orderUnit: "Crate of 9", unitsPerOrder: 9,
    costPrice: 4.94, sellPrice: 7.00, metcashCost: 0,
    avgQtyPerDelivery: 2, orderFrequency: "some"
  },
  {
    itemNumber: "22608", invoiceCode: "00022608",
    barcode: "9310036006954", name: "Pauls Low Fat Buttermilk 600ML",
    category: "fresh", isGstBearing: false,
    orderUnit: "Carton of 6", unitsPerOrder: 6,
    costPrice: 2.35, sellPrice: 3.50, metcashCost: 2.68,
    avgQtyPerDelivery: 3, orderFrequency: "some"
  },
  {
    itemNumber: "230410", invoiceCode: "00230410",
    barcode: "", name: "Pauls Zymil ESL Extra Creamy 1.5L",
    category: "fresh", isGstBearing: false,
    orderUnit: "Crate of 9", unitsPerOrder: 9,
    costPrice: 3.92, sellPrice: 5.47, metcashCost: 0,
    avgQtyPerDelivery: 2, orderFrequency: "occasional"
  },
  {
    itemNumber: "17099", invoiceCode: "00017099",
    barcode: "", name: "Pauls Full Cream Longlife 12X1L",
    category: "uht", isGstBearing: false,
    orderUnit: "CTN", unitsPerOrder: 1,
    costPrice: 31.17, sellPrice: 0, metcashCost: 0,
    avgQtyPerDelivery: 4, orderFrequency: "occasional"
  },

  // ═══════════════════════════════════════════════════
  // FLAVOURED MILK — GST-bearing (10%)
  // Invoice shows discounted "Price Per Item" (ex-GST)
  // ═══════════════════════════════════════════════════
  {
    itemNumber: "16110", invoiceCode: "00016110",
    barcode: "9310036016106", name: "Ice Break Flav Milk Ice Coffee 750ML",
    category: "flavoured", isGstBearing: true,
    orderUnit: "Crate of 12", unitsPerOrder: 12,
    costPrice: 3.85, sellPrice: 4.95, metcashCost: 3.76,
    avgQtyPerDelivery: 3, orderFrequency: "every"
  },
  {
    itemNumber: "41339", invoiceCode: "00041339",
    barcode: "9310036041337", name: "Ice Break Triple Shot Ice Coffee 750ML",
    category: "flavoured", isGstBearing: true,
    orderUnit: "Crate of 12", unitsPerOrder: 12,
    costPrice: 3.85, sellPrice: 4.95, metcashCost: 3.76,
    avgQtyPerDelivery: 3, orderFrequency: "every"
  },
  {
    itemNumber: "16010", invoiceCode: "00016010",
    barcode: "9310036017011", name: "Ice Break Flav Milk Ice/Coff 500ML",
    category: "flavoured", isGstBearing: true,
    orderUnit: "Crate of 16", unitsPerOrder: 16,
    costPrice: 3.05, sellPrice: 3.95, metcashCost: 2.98,
    avgQtyPerDelivery: 3, orderFrequency: "most"
  },
  {
    itemNumber: "41275", invoiceCode: "00041275",
    barcode: "9310036041276", name: "Ice Break Triple Shot Ice Coffee 500ML",
    category: "flavoured", isGstBearing: true,
    orderUnit: "Crate of 16", unitsPerOrder: 16,
    costPrice: 3.05, sellPrice: 3.95, metcashCost: 2.98,
    avgQtyPerDelivery: 3, orderFrequency: "most"
  },
  {
    itemNumber: "73079", invoiceCode: "00073079",
    barcode: "9310036073079", name: "IB Strong Espresso Protein FM 500ML",
    category: "flavoured", isGstBearing: true,
    orderUnit: "Carton of 6", unitsPerOrder: 6,
    costPrice: 3.05, sellPrice: 3.95, metcashCost: 2.98,
    avgQtyPerDelivery: 3, orderFrequency: "most"
  },
  {
    itemNumber: "73893", invoiceCode: "00073893",
    barcode: "9342584073898", name: "OAK Flav Milk Chocolate 600ML",
    category: "flavoured", isGstBearing: true,
    orderUnit: "Crate of 28", unitsPerOrder: 28,
    costPrice: 2.95, sellPrice: 4.20, metcashCost: 2.88,
    avgQtyPerDelivery: 2, orderFrequency: "every"
  },
  {
    itemNumber: "73894", invoiceCode: "00073894",
    barcode: "9342584047295", name: "OAK Flav Milk Strawberry 600ML",
    category: "flavoured", isGstBearing: true,
    orderUnit: "Crate of 28", unitsPerOrder: 28,
    costPrice: 2.95, sellPrice: 4.20, metcashCost: 2.88,
    avgQtyPerDelivery: 3, orderFrequency: "every"
  },
  {
    itemNumber: "73895", invoiceCode: "00073895",
    barcode: "9310177800404", name: "OAK Flav Milk Iced Coffee 600ML",
    category: "flavoured", isGstBearing: true,
    orderUnit: "Crate of 28", unitsPerOrder: 28,
    costPrice: 2.95, sellPrice: 4.20, metcashCost: 2.88,
    avgQtyPerDelivery: 2, orderFrequency: "every"
  },
  {
    itemNumber: "70526", invoiceCode: "00070526",
    barcode: "9310036070528", name: "OAK Plus FM No Sugar Added Choc 500ML",
    category: "flavoured", isGstBearing: true,
    orderUnit: "Carton of 6", unitsPerOrder: 6,
    costPrice: 3.22, sellPrice: 4.40, metcashCost: 3.15,
    avgQtyPerDelivery: 3, orderFrequency: "most"
  },
  {
    itemNumber: "230150", invoiceCode: "00230150",
    barcode: "9310036230151", name: "OAK Plus FM NAS Salted Caramel 500ML",
    category: "flavoured", isGstBearing: true,
    orderUnit: "Carton of 6", unitsPerOrder: 6,
    costPrice: 3.22, sellPrice: 4.40, metcashCost: 0,
    avgQtyPerDelivery: 3, orderFrequency: "most"
  },
  {
    itemNumber: "230500", invoiceCode: "00230500",
    barcode: "9310036230502", name: "OAK Peppermint Crisp FM 6X600ML",
    category: "flavoured", isGstBearing: true,
    orderUnit: "Carton of 6", unitsPerOrder: 6,
    costPrice: 2.95, sellPrice: 4.20, metcashCost: 0,
    avgQtyPerDelivery: 3, orderFrequency: "most"
  },
  {
    itemNumber: "228500", invoiceCode: "00228500",
    barcode: "9310036228509", name: "Pauls Plus Choc FM 6X400ML",
    category: "flavoured", isGstBearing: true,
    orderUnit: "Carton of 6", unitsPerOrder: 6,
    costPrice: 3.05, sellPrice: 4.40, metcashCost: 0,
    avgQtyPerDelivery: 4, orderFrequency: "most"
  },
  {
    itemNumber: "228510", invoiceCode: "00228510",
    barcode: "9310036228516", name: "Pauls Plus Banana Honey FM 6X400ML",
    category: "flavoured", isGstBearing: true,
    orderUnit: "Carton of 6", unitsPerOrder: 6,
    costPrice: 3.05, sellPrice: 4.40, metcashCost: 0,
    avgQtyPerDelivery: 4, orderFrequency: "most"
  },
  {
    itemNumber: "230550", invoiceCode: "00230550",
    barcode: "", name: "Pauls Plus Espresso Caramel FM 400ML",
    category: "flavoured", isGstBearing: true,
    orderUnit: "Carton of 6", unitsPerOrder: 6,
    costPrice: 3.05, sellPrice: 4.40, metcashCost: 0,
    avgQtyPerDelivery: 4, orderFrequency: "most"
  },
  {
    itemNumber: "230540", invoiceCode: "00230540",
    barcode: "9310036230540", name: "Pauls Plus Summer Berries FM 400ML",
    category: "flavoured", isGstBearing: true,
    orderUnit: "Carton of 6", unitsPerOrder: 6,
    costPrice: 3.05, sellPrice: 4.40, metcashCost: 0,
    avgQtyPerDelivery: 4, orderFrequency: "most"
  },
  {
    itemNumber: "60444", invoiceCode: "00060444",
    barcode: "9310036060444", name: "Pauls Zymil Flav Milk Choc 6X400ML",
    category: "flavoured", isGstBearing: true,
    orderUnit: "Carton of 6", unitsPerOrder: 6,
    costPrice: 3.05, sellPrice: 4.00, metcashCost: 2.98,
    avgQtyPerDelivery: 6, orderFrequency: "some"
  },
  {
    itemNumber: "73653", invoiceCode: "00073653",
    barcode: "9310036073659", name: "OAK FM Chocolate Lactose Free 600ML",
    category: "flavoured", isGstBearing: true,
    orderUnit: "Carton of 6", unitsPerOrder: 6,
    costPrice: 2.95, sellPrice: 4.10, metcashCost: 2.88,
    avgQtyPerDelivery: 3, orderFrequency: "some"
  },
  {
    itemNumber: "79060", invoiceCode: "00079060",
    barcode: "9310036079064", name: "OAK FM Caramel Coffee 600ML",
    category: "flavoured", isGstBearing: true,
    orderUnit: "Carton of 6", unitsPerOrder: 6,
    costPrice: 2.95, sellPrice: 4.20, metcashCost: 2.88,
    avgQtyPerDelivery: 3, orderFrequency: "some"
  },
  {
    itemNumber: "228180", invoiceCode: "00228180",
    barcode: "9310036228189", name: "IB Strong Espresso Protein FM 750ML",
    category: "flavoured", isGstBearing: true,
    orderUnit: "Crate of 12", unitsPerOrder: 12,
    costPrice: 3.85, sellPrice: 5.25, metcashCost: 3.76,
    avgQtyPerDelivery: 2, orderFrequency: "some"
  },
  {
    itemNumber: "61108", invoiceCode: "00061108",
    barcode: "", name: "OAK UHT Flav Milk Chocolate 6X500ML",
    category: "uht", isGstBearing: true,
    orderUnit: "Carton of 6", unitsPerOrder: 6,
    costPrice: 3.45, sellPrice: 0, metcashCost: 0,
    avgQtyPerDelivery: 3, orderFrequency: "most"
  },
  {
    itemNumber: "61924", invoiceCode: "00061924",
    barcode: "", name: "OAK UHT Flav Milk Strawberry 6X500ML",
    category: "uht", isGstBearing: true,
    orderUnit: "Carton of 6", unitsPerOrder: 6,
    costPrice: 3.45, sellPrice: 0, metcashCost: 0,
    avgQtyPerDelivery: 3, orderFrequency: "most"
  },
  {
    itemNumber: "61747", invoiceCode: "00061747",
    barcode: "", name: "OAK UHT Flav Milk Iced Coffee 6X500ML",
    category: "uht", isGstBearing: true,
    orderUnit: "Carton of 6", unitsPerOrder: 6,
    costPrice: 3.45, sellPrice: 0, metcashCost: 0,
    avgQtyPerDelivery: 3, orderFrequency: "most"
  },
  {
    itemNumber: "73896", invoiceCode: "00073896",
    barcode: "9342584070804", name: "OAK Flav Milk Vanilla Malt 600ML",
    category: "flavoured", isGstBearing: true,
    orderUnit: "Crate of 28", unitsPerOrder: 28,
    costPrice: 2.95, sellPrice: 3.95, metcashCost: 2.88,
    avgQtyPerDelivery: 2, orderFrequency: "occasional"
  },
  {
    itemNumber: "34892", invoiceCode: "00034892",
    barcode: "9342584034899", name: "OAK Flav Milk Banana 600ML",
    category: "flavoured", isGstBearing: true,
    orderUnit: "Crate of 28", unitsPerOrder: 28,
    costPrice: 2.95, sellPrice: 4.20, metcashCost: 2.88,
    avgQtyPerDelivery: 2, orderFrequency: "occasional"
  },
  {
    itemNumber: "34868", invoiceCode: "00034868",
    barcode: "9342584034868", name: "OAK Flav Milk Chocolate 300ML BTL",
    category: "flavoured", isGstBearing: true,
    orderUnit: "Crate of 50", unitsPerOrder: 50,
    costPrice: 1.97, sellPrice: 2.95, metcashCost: 1.91,
    avgQtyPerDelivery: 3, orderFrequency: "occasional"
  },
  {
    itemNumber: "34964", invoiceCode: "00034964",
    barcode: "9342584034967", name: "OAK Flav Milk Strawberry 300ML BTL",
    category: "flavoured", isGstBearing: true,
    orderUnit: "Crate of 50", unitsPerOrder: 50,
    costPrice: 1.97, sellPrice: 2.95, metcashCost: 1.91,
    avgQtyPerDelivery: 3, orderFrequency: "occasional"
  },
  {
    itemNumber: "34390", invoiceCode: "00034390",
    barcode: "9342584034394", name: "OAK Flav Milk Iced Coffee 300ML BTL",
    category: "flavoured", isGstBearing: true,
    orderUnit: "Crate of 50", unitsPerOrder: 50,
    costPrice: 1.97, sellPrice: 0, metcashCost: 1.91,
    avgQtyPerDelivery: 3, orderFrequency: "occasional"
  },
];

// ═══ Quick reference stats ═══
// Total SKUs: 53
// Fresh milk: 26 SKUs
// Flavoured milk: 24 SKUs  
// UHT: 3 SKUs
// Average weekly spend: ~$580
// Deliveries per week: 3 (Mon/Wed/Fri pattern)
// Average per delivery: ~$200-300
// Biggest single delivery: ~$450 (big restock day)
