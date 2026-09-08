/**
 * Single source of truth for bulk-upload Excel template generation.
 * Keep in sync with product.controller.js bulk validation / ZIP matching rules.
 * Categories (Lookups) are loaded from DB at download time — not listed here.
 */

'use strict';

/** Spreadsheet column letter from 0-based index (0 → A, 25 → Z, 26 → AA). */
function colLetter(index) {
  let n = Number(index);
  if (!Number.isFinite(n) || n < 0) return '';
  let s = '';
  n += 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/**
 * Column definitions for BulkUpload_NewProducts.
 * `header` is the exact Excel header used by import mapping.
 */
const BULK_UPLOAD_COLUMNS = [
  {
    key: 'name',
    header: 'name',
    required: true,
    dataType: 'Text',
    format: 'Any text',
    example: '313 Portable Bluetooth Speaker',
    notes:
      'Internal product name. Multi-variant rows of the SAME productCode base MUST share this exact name. Different products MAY share a display name if their productCode bases differ.',
  },
  {
    key: 'title',
    header: 'title',
    required: true,
    dataType: 'Text',
    format: 'Any text',
    example: '313 Portable Bluetooth Speaker for Music & Entertainment',
    notes:
      'Customer-facing title. Keep identical across variant rows of the same product (same productCode base).',
  },
  {
    key: 'description',
    header: 'description',
    required: true,
    dataType: 'Text',
    format: 'Any text (HTML allowed)',
    example: 'Clear sound, deep bass. Compact and rechargeable.',
    notes:
      'Product description. Keep identical across variant rows of the same product. HTML tags are supported.',
  },
  {
    key: 'category',
    header: 'category',
    required: true,
    dataType: 'List ▾',
    format: 'Must match an existing active category name',
    example: 'Smart Life Gadgets',
    notes:
      'Exact category name from store (dropdown). Must already exist. Matching is case-insensitive in import.',
  },
  {
    key: 'brand',
    header: 'brand',
    required: false,
    dataType: 'Text',
    format: 'Any text',
    example: 'Generic',
    notes: 'Brand or manufacturer name.',
  },
  {
    key: 'status',
    header: 'status',
    required: true,
    dataType: 'List ▾',
    format: 'active | draft | archived',
    example: 'active',
    notes: "Dropdown. 'active'=live, 'draft'=hidden, 'archived'=discontinued.",
  },
  {
    key: 'isfeatured',
    header: 'isfeatured',
    required: true,
    dataType: 'List ▾',
    format: 'true | false',
    example: 'true',
    notes: 'Dropdown. Feature this product on homepage / featured section?',
  },
  {
    key: 'basePrice',
    header: 'basePrice',
    required: true,
    dataType: 'Number',
    format: 'Positive number (MRP)',
    example: '799',
    notes: 'Original / MRP price for this variant. Must be > 0.',
  },
  {
    key: 'salePrice',
    header: 'salePrice',
    required: false,
    dataType: 'Number',
    format: 'Positive number, must be < basePrice',
    example: '349',
    notes: 'Discounted price. Leave blank if no sale. Must be less than basePrice when set.',
  },
  {
    key: 'quantity',
    header: 'quantity',
    required: true,
    dataType: 'Number',
    format: 'Non-negative integer',
    example: '100',
    notes: 'Stock quantity for this specific variant.',
  },
  {
    key: 'productCode',
    header: 'productCode',
    required: true,
    dataType: 'Text',
    format: 'BASE or BASE-N (e.g. 2662 or 2662-1)',
    example: '2662-1',
    notes:
      'CRITICAL identity + ZIP folder key. Single variant: BASE (e.g. 2662). Multi-variant: BASE-1, BASE-2, … continuous from 1. Same BASE = same product. Exact productCode must be unique across the catalogue. Folder name in ZIP must match this code (2662-1 → folder "2662-1").',
  },
  {
    key: 'variantAttributes',
    header: 'variantAttributes',
    required: false,
    dataType: 'Text',
    format: 'Key:Value | Key:Value',
    example: 'Design:1',
    notes:
      'Variant-specific attributes that differentiate rows of the same product. Pipe (|) between pairs, colon between key and value.',
  },
  {
    key: 'weight',
    header: 'weight',
    required: true,
    dataType: 'Decimal',
    format: 'Weight in kg (> 0)',
    example: '0.4',
    notes: 'Shipping weight in kg. Required and must be greater than 0.',
  },
  {
    key: 'length',
    header: 'length',
    required: true,
    dataType: 'Number',
    format: 'Length in cm (> 0)',
    example: '13',
    notes: 'Package dimension — length (cm). Required > 0.',
  },
  {
    key: 'width',
    header: 'width',
    required: true,
    dataType: 'Number',
    format: 'Width in cm (> 0)',
    example: '7',
    notes: 'Package dimension — width (cm). Required > 0.',
  },
  {
    key: 'height',
    header: 'height',
    required: true,
    dataType: 'Number',
    format: 'Height in cm (> 0)',
    example: '13',
    notes: 'Package dimension — height (cm). Required > 0.',
  },
  {
    key: 'soldEnabled',
    header: 'soldEnabled',
    required: true,
    dataType: 'List ▾',
    format: 'true | false',
    example: 'true',
    notes: "Dropdown. Show 'X sold' social proof on product page?",
  },
  {
    key: 'soldCount',
    header: 'soldCount',
    required: false,
    dataType: 'Number',
    format: 'Positive integer',
    example: '2242',
    notes: 'Units sold to display when soldEnabled=true.',
  },
  {
    key: 'fomoEnabled',
    header: 'fomoEnabled',
    required: true,
    dataType: 'List ▾',
    format: 'true | false',
    example: 'true',
    notes: 'Dropdown. Enable FOMO urgency widget on this product?',
  },
  {
    key: 'fomoType',
    header: 'fomoType',
    required: false,
    dataType: 'List ▾',
    format: 'viewing_now | product_left | custom',
    example: 'viewing_now',
    notes: 'Dropdown. Used when fomoEnabled=true. Fill only the matching value column below.',
  },
  {
    key: 'viewingNow',
    header: 'viewingNow',
    required: false,
    dataType: 'Number',
    format: 'Positive integer',
    example: '55',
    notes: 'Live viewer count when fomoType=viewing_now.',
  },
  {
    key: 'productLeft',
    header: 'productLeft',
    required: false,
    dataType: 'Number',
    format: 'Positive integer',
    example: '12',
    notes: "Shows 'Only X left!' when fomoType=product_left.",
  },
  {
    key: 'customMessage',
    header: 'customMessage',
    required: false,
    dataType: 'Text',
    format: 'Short urgency text',
    example: 'Hurry! Limited Stock',
    notes: 'Custom urgency text when fomoType=custom.',
  },
  {
    key: 'productAttributes',
    header: 'productAttributes',
    required: false,
    dataType: 'Text',
    format: 'Key:Value | Key:Value',
    example: 'Material:Plastic | Warranty:6 Months',
    notes: 'Non-variant product specs. Same across all variant rows of a product.',
  },
  {
    key: 'images',
    header: 'images (LEAVE BLANK)',
    required: false,
    blankOnly: true,
    dataType: '—',
    format: 'MUST BE LEFT EMPTY for ZIP mode',
    example: '(leave blank)',
    notes:
      'Leave blank for ZIP bulk create. Images come from ZIP folders named by productCode. (CSV URL mode may use comma-separated http(s) URLs instead.)',
  },
  {
    key: 'hsnCode',
    header: 'hsnCode',
    required: false,
    dataType: 'Text',
    format: '6–8 digit HSN code',
    example: '85183000',
    notes: 'HSN for GST. Leave blank if not applicable.',
  },
  {
    key: 'gstRate',
    header: 'gstRate',
    required: false,
    dataType: 'List ▾',
    format: '0 | 5 | 12 | 18 | 28',
    example: '18',
    notes: 'GST rate percent (dropdown).',
  },
  {
    key: 'isFragile',
    header: 'isFragile',
    required: false,
    dataType: 'List ▾',
    format: 'true | false',
    example: 'false',
    notes: 'Dropdown. Mark fragile for special packaging/handling.',
  },
  {
    key: 'wholesale',
    header: 'wholesale',
    required: true,
    dataType: 'List ▾',
    format: 'true | false',
    example: 'true',
    notes: 'Dropdown. Enable wholesale pricing for this variant?',
  },
  {
    key: 'wholesaleBase',
    header: 'wholesaleBase',
    required: false,
    dataType: 'Number',
    format: 'Positive number',
    example: '799',
    notes: 'Wholesale MRP. Required when wholesale=true.',
  },
  {
    key: 'wholesaleSale',
    header: 'wholesaleSale',
    required: false,
    dataType: 'Number',
    format: 'Positive number, ≤ wholesaleBase',
    example: '260',
    notes: 'Wholesale sale price. Optional even when wholesale=true.',
  },
  {
    key: 'minimumOrderQuantity',
    header: 'minimumOrderQuantity',
    required: false,
    dataType: 'Number',
    format: 'Positive integer',
    example: '10',
    notes: 'Wholesale MOQ. Recommended when wholesale=true.',
  },
  {
    key: 'countryOfOrigin',
    header: 'countryOfOrigin',
    required: false,
    dataType: 'Text',
    format: 'Country name',
    example: 'India',
    notes: 'Country of origin (optional).',
  },
];

const STATUS_OPTIONS = ['active', 'draft', 'archived'];
const BOOL_OPTIONS = ['true', 'false'];
const FOMO_TYPE_OPTIONS = ['viewing_now', 'product_left', 'custom'];
const GST_OPTIONS = ['0', '5', '12', '18', '28'];

/** Example rows for the data sheet (multi-variant sample). */
const EXAMPLE_PRODUCT_ROWS = [
  {
    name: '313 Portable Bluetooth Speaker',
    title: '313 Portable Bluetooth Speaker for Music & Entertainment (Design and color may differ slightly)',
    description:
      '313 portable Bluetooth speaker delivers clear sound and deep bass. Compact, rechargeable, and perfect for music, travel, parties, and fun.',
    category: 'Smart Life Gadgets',
    brand: 'Generic',
    status: 'active',
    isfeatured: 'true',
    basePrice: '799',
    salePrice: '349',
    quantity: '100',
    productCode: '2662-1',
    variantAttributes: 'Design:1',
    weight: '0.4',
    length: '13',
    width: '7',
    height: '13',
    soldEnabled: 'true',
    soldCount: '2242',
    fomoEnabled: 'true',
    fomoType: 'viewing_now',
    viewingNow: '55',
    productLeft: '',
    customMessage: '',
    productAttributes: '',
    images: '',
    hsnCode: '',
    gstRate: '',
    isFragile: '',
    wholesale: 'true',
    wholesaleBase: '799',
    wholesaleSale: '260',
    minimumOrderQuantity: '',
    countryOfOrigin: '',
  },
  {
    name: '313 Portable Bluetooth Speaker',
    title: '313 Portable Bluetooth Speaker for Music & Entertainment (Design and color may differ slightly)',
    description:
      '313 portable Bluetooth speaker delivers clear sound and deep bass. Compact, rechargeable, and perfect for music, travel, parties, and fun.',
    category: 'Smart Life Gadgets',
    brand: 'Generic',
    status: 'active',
    isfeatured: 'true',
    basePrice: '799',
    salePrice: '349',
    quantity: '100',
    productCode: '2662-2',
    variantAttributes: 'Design:2',
    weight: '0.4',
    length: '13',
    width: '7',
    height: '13',
    soldEnabled: 'true',
    soldCount: '2242',
    fomoEnabled: 'true',
    fomoType: 'viewing_now',
    viewingNow: '55',
    productLeft: '',
    customMessage: '',
    productAttributes: '',
    images: '',
    hsnCode: '',
    gstRate: '',
    isFragile: '',
    wholesale: 'true',
    wholesaleBase: '799',
    wholesaleSale: '260',
    minimumOrderQuantity: '',
    countryOfOrigin: '',
  },
];

function requiredLabel(col) {
  if (col.blankOnly) return '🚫 Blank';
  return col.required ? '✅ Yes' : '⬜ No';
}

/**
 * Build Instructions sheet as array-of-arrays (AOA).
 */
function buildInstructionsAoa() {
  const rows = [];
  rows.push([
    '📋  Bulk Product Upload (New Products) — Field Instructions',
    '',
    '',
    '',
    '',
    '',
    '',
  ]);
  rows.push([
    "Use this sheet before filling 'BulkUpload_NewProducts'. For ZIP mode, leave the images column BLANK and upload a ZIP of productCode folders.",
    '',
    '',
    '',
    '',
    '',
    '',
  ]);
  rows.push([
    '📁  IMAGE UPLOAD (ZIP): Leave images blank → one folder per productCode (folder name = productCode) → put images inside → zip the parent folder → upload Excel + ZIP together.',
    '',
    '',
    '',
    '',
    '',
    '',
  ]);
  rows.push([
    '🔑  IDENTITY: productCode is the unique key (BASE or BASE-N). Same productCode base = same product (shared name/title/description). Different bases may reuse the same display name.',
    '',
    '',
    '',
    '',
    '',
    '',
  ]);
  rows.push(['']);
  rows.push([
    'Column',
    'Field Name',
    'Required?',
    'Data Type',
    'Allowed Values / Format',
    'Example',
    'Notes',
  ]);

  BULK_UPLOAD_COLUMNS.forEach((col, idx) => {
    rows.push([
      colLetter(idx),
      col.key,
      requiredLabel(col),
      col.dataType,
      col.format,
      col.example,
      col.notes,
    ]);
  });

  rows.push(['']);
  rows.push(['LEGEND', '', '', '', '', '', '']);
  rows.push(['   ✅  Required field — must be filled in every row', '', '', '', '', '', '']);
  rows.push(['   ⬜  Optional field — leave blank if not applicable', '', '', '', '', '', '']);
  rows.push([
    '   ⚠️   Dropdown validation — use ONLY the exact allowed values from the list',
    '',
    '',
    '',
    '',
    '',
    '',
  ]);
  rows.push([
    '   🚫  images column — leave blank for ZIP bulk create',
    '',
    '',
    '',
    '',
    '',
    '',
  ]);
  rows.push(['']);
  rows.push(['📁  IMAGE FOLDER STRUCTURE — HOW TO PREPARE YOUR ZIP', '', '', '', '', '', '']);
  rows.push([
    'STEP 1 — One folder per productCode',
    "Create a folder whose name is EXACTLY the productCode of that row (e.g. 2662-1 → folder '2662-1').",
    '',
    '',
    '',
    '',
    '',
  ]);
  rows.push([
    'STEP 2 — Place images inside',
    'Add 1+ images (JPG / JPEG / PNG / GIF / WEBP). Prefer 01.jpg, 02.jpg for ordering. First sorted file is often used as thumbnail.',
    '',
    '',
    '',
    '',
    '',
  ]);
  rows.push([
    'STEP 3 — Multi-variant = multiple folders',
    'Each variant productCode needs its own folder with images (even if images are identical, duplicate them).',
    '',
    '',
    '',
    '',
    '',
  ]);
  rows.push([
    'STEP 4 — Parent folder',
    "Put all productCode folders inside one parent folder (e.g. product_images/), then ZIP that parent only.",
    '',
    '',
    '',
    '',
    '',
  ]);
  rows.push([
    'STEP 5 — Upload',
    'In Bulk Create: upload Excel + ZIP. System matches folders to rows via productCode.',
    '',
    '',
    '',
    '',
    '',
  ]);
  rows.push(['']);
  rows.push(['GENERAL TIPS', '', '', '', '', '', '']);
  rows.push([
    '1. Multi-variant = same name/title/description/category for all rows of one BASE; only productCode, variantAttributes, price, qty differ. Codes must be BASE-1, BASE-2, … continuous.',
    '',
    '',
    '',
    '',
    '',
    '',
  ]);
  rows.push([
    '2. Do NOT rename or reorder column headers on BulkUpload_NewProducts — import mapping depends on them.',
    '',
    '',
    '',
    '',
    '',
    '',
  ]);
  rows.push([
    '3. Dropdown fields: pick from the list only. Wrong values fail validation.',
    '',
    '',
    '',
    '',
    '',
    '',
  ]);
  rows.push([
    '4. fomoType: fill only the matching column (viewingNow / productLeft / customMessage).',
    '',
    '',
    '',
    '',
    '',
    '',
  ]);
  rows.push([
    '5. wholesale=true → wholesaleBase is required. wholesaleSale and minimumOrderQuantity recommended.',
    '',
    '',
    '',
    '',
    '',
    '',
  ]);
  rows.push([
    '6. Attributes format: Key:Value | Key:Value (pipe between pairs, colon between key and value).',
    '',
    '',
    '',
    '',
    '',
    '',
  ]);
  rows.push([
    '7. productCode must be unique per variant across the whole catalogue (not only this file).',
    '',
    '',
    '',
    '',
    '',
    '',
  ]);
  rows.push([
    '8. Category must already exist in admin. New categories: add in admin first, then re-download this template (dropdown refreshes).',
    '',
    '',
    '',
    '',
    '',
    '',
  ]);
  rows.push([
    '9. Image formats: JPG, JPEG, PNG, GIF, WEBP. Empty / missing ZIP folders fail the whole ZIP upload (all-or-nothing).',
    '',
    '',
    '',
    '',
    '',
    '',
  ]);
  rows.push([
    '10. For ZIP mode the images column MUST stay empty — do not paste URLs there.',
    '',
    '',
    '',
    '',
    '',
    '',
  ]);

  return rows;
}

/**
 * Build Image_ZIP_Guide sheet AOA (tree diagram + tips).
 */
function buildImageZipGuideAoa() {
  return [
    ['📁  How to Prepare Your Image ZIP File', ''],
    ['', ''],
    ['', 'product_images/                    ← Parent folder (zip this)'],
    ['', '├── 2662-1/                         ← productCode of variant 1'],
    ['', '│   ├── 01.jpg'],
    ['', '│   ├── 02.jpg'],
    ['', '│   └── 03.jpg'],
    ['', '├── 2662-2/                         ← productCode of variant 2'],
    ['', '│   ├── 01.jpg'],
    ['', '│   └── 02.jpg'],
    ['', '├── 3001/                            ← single-variant product (BASE only)'],
    ['', '│   ├── 01.jpg'],
    ['', '│   └── 02.jpg'],
    ['', '└── 3002-1/                         ← another multi-variant series'],
    ['', '    ├── 01.jpg'],
    ['', '    └── 02.jpg'],
    ['', ''],
    ['', "➡️  Right-click 'product_images' → Compress / Send to ZIP → product_images.zip"],
    ['', '➡️  Upload product_images.zip + this Excel in Bulk Create (ZIP images mode).'],
    ['', ''],
    ['', 'Rules enforced by the server:'],
    ['', '• Folder name must match productCode exactly (including -N suffix).'],
    ['', '• Each folder needs ≥1 image: .jpg .jpeg .png .gif .webp'],
    ['', '• Missing / empty folders block the entire ZIP import (fix all errors, fix, re-upload).'],
    ['', '• Do not open/re-save the ZIP in Excel/OS while upload is running.'],
  ];
}

function getProductSheetHeaders() {
  return BULK_UPLOAD_COLUMNS.map((c) => c.header);
}

function buildExampleProductAoa() {
  const headers = getProductSheetHeaders();
  const rows = [headers];
  for (const example of EXAMPLE_PRODUCT_ROWS) {
    rows.push(
      BULK_UPLOAD_COLUMNS.map((col) => {
        const v = example[col.key];
        return v == null ? '' : String(v);
      })
    );
  }
  return rows;
}

module.exports = {
  BULK_UPLOAD_COLUMNS,
  STATUS_OPTIONS,
  BOOL_OPTIONS,
  FOMO_TYPE_OPTIONS,
  GST_OPTIONS,
  EXAMPLE_PRODUCT_ROWS,
  colLetter,
  buildInstructionsAoa,
  buildImageZipGuideAoa,
  getProductSheetHeaders,
  buildExampleProductAoa,
};
