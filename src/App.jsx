import React, { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { loadStripe } from "@stripe/stripe-js";
import { Elements, CardElement, useStripe, useElements } from "@stripe/react-stripe-js";

// ─── Brand logos (static file refs — no base64 in JS bundle) ─────────────────────────
// In production: place logo-nav.png and logo-hero.png in your /public folder.
const LOGO_NAV  = "/logo-nav.svg";
const LOGO_HERO = "/logo-hero.svg";

// ─── FX rates (base: TZS) ────────────────────────────────────────────────────────────
// SEED_FX = fallback rates used when the live rate API is unavailable.
// All rates are expressed as: 1 TZS = X [currency]
// Updated live every 6 hours via useFXRates() hook below.
// Sources: CBK API (TZS→USD anchor), Open Exchange Rates for cross-rates.
const SEED_FX = {
TZS: 1,
KES: 0.04651,   // 1 TZS ≈ 0.0465 KES
USD: 0.000358,
EUR: 0.000330,
GBP: 0.000284,
CNY: 0.002584,
// ── African expansion currencies ──
NGN: 0.5820,    // Nigerian Naira   (~1,716 NGN/USD)
GHS: 0.004310,  // Ghanaian Cedi    (~82.9 GHS/USD)
ETB: 0.04020,   // Ethiopian Birr   (~108 ETB/USD) — capital controls apply
EGP: 0.01740,   // Egyptian Pound   (~47.9 EGP/USD)
ZAR: 0.006640,  // South African Rand (~18.4 ZAR/USD)
RWF: 0.4420,    // Rwandan Franc    (~1,280 RWF/USD)
UGX: 1.3480,    // Ugandan Shilling (~3,770 UGX/USD)
XOF: 0.2165,    // West African CFA Franc (pegged to EUR)
MAD: 0.003490,  // Moroccan Dirham  (~9.7 MAD/USD)
};

// Active FX map — starts from seed, gets updated by useFXRates() hook
let FX = { ...SEED_FX };

const CURRENCIES = [
{ code:"TZS", symbol:"TZS", flag:"🇹🇿", label:"Tanzanian Shilling",   decimals:0 },
{ code:"KES", symbol:"KSh", flag:"🇰🇪", label:"Kenyan Shilling",       decimals:0 },
{ code:"USD", symbol:"$",   flag:"🇺🇸", label:"US Dollar",             decimals:2 },
{ code:"EUR", symbol:"€",   flag:"🇪🇺", label:"Euro",                  decimals:2 },
{ code:"GBP", symbol:"£",   flag:"🇬🇧", label:"British Pound",         decimals:2 },
{ code:"CNY", symbol:"¥",   flag:"🇨🇳", label:"Chinese Yuan",          decimals:2 },
{ code:"NGN", symbol:"₦",   flag:"🇳🇬", label:"Nigerian Naira",        decimals:0 },
{ code:"GHS", symbol:"₵",   flag:"🇬🇭", label:"Ghanaian Cedi",         decimals:2 },
{ code:"ETB", symbol:"Br",  flag:"🇪🇹", label:"Ethiopian Birr",        decimals:2 },
{ code:"EGP", symbol:"E£",  flag:"🇪🇬", label:"Egyptian Pound",        decimals:2 },
{ code:"ZAR", symbol:"R",   flag:"🇿🇦", label:"South African Rand",    decimals:2 },
{ code:"RWF", symbol:"RF",  flag:"🇷🇼", label:"Rwandan Franc",         decimals:0 },
{ code:"UGX", symbol:"USh", flag:"🇺🇬", label:"Ugandan Shilling",      decimals:0 },
{ code:"XOF", symbol:"CFA", flag:"🌍",  label:"West African CFA Franc", decimals:0 },
{ code:"MAD", symbol:"DH",  flag:"🇲🇦", label:"Moroccan Dirham",       decimals:2 },
];

const CURRENCY_LOCALES = {
TZS:"sw-TZ", KES:"sw-KE", USD:"en-US", EUR:"de-DE", GBP:"en-GB",
CNY:"zh-CN", UGX:"sw-UG", XOF:"fr-SN", MAD:"ar-MA", ZAR:"en-ZA",
RWF:"rw-RW", GHS:"en-GH", NGN:"en-NG", INR:"en-IN", JPY:"ja-JP",
};
function fmt(tzsPrice, code) {
const price  = (tzsPrice == null || isNaN(Number(tzsPrice))) ? 0 : Number(tzsPrice);
const c      = CURRENCIES.find(x => x.code === code);
const rate   = FX[code];
if (!c || rate === undefined) return `TZS ${price.toLocaleString("sw-TZ")}`;
const val    = price * rate;
const locale = CURRENCY_LOCALES[code] ?? "en-US";
return `${c.symbol}${val.toLocaleString(locale,{ minimumFractionDigits:c.decimals, maximumFractionDigits:c.decimals })}`;
}
function sym(code) { return CURRENCIES.find(x => x.code === code)?.symbol ?? code; }

// ─── Card helpers ───────────────────────────────────────────────────────────────────
function detectCard(n) {
const s = n.replace(/\s/g,"");
if (/^4/.test(s))           return "visa";
if (/^5[1-5]/.test(s))     return "mastercard";
if (/^3[47]/.test(s))      return "amex";
if (/^6(?:011|5)/.test(s)) return "discover";
return null;
}
function fmtCard(v)   { return v.replace(/\D/g,"").slice(0,16).replace(/(.{4})/g,"$1 ").trim(); }
function fmtExpiry(v) { const n=v.replace(/\D/g,"").slice(0,4); return n.length>=3?n.slice(0,2)+"/"+n.slice(2):n; }

// ─── Phone number validation (E.164) ────────────────────────────────────────────────
// Validates and normalises mobile numbers to E.164 format without an external library.
// Covers every dial prefix used in the app (TZ, KE, UG, RW, NG, GH, ZA).
// Returns { valid, e164, error } — always call this before sending to a USSD/SMS API.

const PHONE_RULES = [
// [ dialPrefix, minLocalDigits, maxLocalDigits, localRegex,           country ]
{ prefix:"+255", min:9, max:9,  re:/^(6|7)\d{8}$/,    country:"TZ" }, // Vodacom/Tigo/Airtel/Halotel
{ prefix:"+254", min:9, max:9,  re:/^(7|1)\d{8}$/,    country:"KE" }, // Safaricom/Airtel KE
{ prefix:"+256", min:9, max:9,  re:/^(7)\d{8}$/,      country:"UG" },
{ prefix:"+250", min:9, max:9,  re:/^(7)\d{8}$/,      country:"RW" },
{ prefix:"+234", min:10,max:10, re:/^(7|8|9)\d{9}$/,  country:"NG" },
{ prefix:"+233", min:9, max:9,  re:/^(2|5)\d{8}$/,    country:"GH" },
{ prefix:"+27",  min:9, max:9,  re:/^(6|7|8)\d{8}$/,  country:"ZA" },
];


function luhnCheck(num) {
  let sum = 0, alt = false;
  for (let i = num.length - 1; i >= 0; i--) {
    let d = parseInt(num[i], 10);
    if (alt) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}
function validateCardFields(num, name, expiry, cvv) {
  const cleaned = num.replace(/\s/g, "");
  if (!/^\d{13,19}$/.test(cleaned))
    return "Invalid card number";
  if (!luhnCheck(cleaned))
    return "Card number is invalid";
  if (name.trim().length < 2)
    return "Enter the name as it appears on the card";
  const [mm, yy] = (expiry || "").split("/");
  const now = new Date();
  const exp = new Date(2000 + parseInt(yy || "0", 10), parseInt(mm || "0", 10) - 1);
  if (!mm || !yy || exp <= now)
    return "Card has expired or expiry date is invalid";
  if (!/^\d{3,4}$/.test(cvv))
    return "CVV must be 3 or 4 digits";
  return null; // valid
}

function validatePhone(rawInput) {
if (!rawInput || rawInput.trim() === "") {
return { valid: false, e164: "", error: "Please enter your mobile number." };
}

// Strip spaces, dashes, parentheses
const cleaned = rawInput.replace(/[\s-().]/g, "");

// Try to match a known dial prefix
for (const rule of PHONE_RULES) {
if (cleaned.startsWith(rule.prefix)) {
const local = cleaned.slice(rule.prefix.length);
if (local.length < rule.min || local.length > rule.max || !rule.re.test(local)) {
return {
valid: false,
e164: "",
error: `Invalid ${rule.country} number. Expected format: ${rule.prefix} 7XX XXX XXX`,
};
}
return { valid: true, e164: cleaned, error: "" };
}
}

// No recognised prefix — might be a local number (user forgot +255 etc.)
// Try the two most common prefixes for the app's base countries
if (/^0\d{9}$/.test(cleaned)) {
return {
valid: false, e164: "",
error: "Please include your country code, e.g. +255 712 345 678",
};
}
if (/^\d{7,13}$/.test(cleaned)) {
return {
valid: false, e164: "",
error: "Please start your number with a country code e.g. +255 or +254",
};
}

return { valid: false, e164: "", error: "Please enter a valid mobile number." };
}

// Auto-formats phone as user types: strips non-digits, re-inserts the + prefix,
// groups into blocks of 3 for readability: +255 712 345 678
function fmtPhone(raw) {
const digits = raw.replace(/\D/g, "");
if (!digits) return "";
// Detect prefix length (1--3 digits: +1, +27, +255, +234)
const withPlus = raw.trimStart().startsWith("+") ? "+" + digits : digits;
return withPlus; // return clean form; display grouping can be CSS-level
}

// ─── Static data ────────────────────────────────────────────────────────────────────
// marketPrice: nearest physical market reference price in TZS (Kariakoo for TZ, Gikomba for KE)
// videoUrl: short farmer harvest preview — real uploads go to /api/products/:id/video
const PRODUCTS = [
{ id:1, emoji:"🥑", name:"Hass Avocados",  tzsPrice:7500,  unit:"KG",    farmer:"Mama Zawadi",   farm:"Kilifi Farm, Kilifi County",   dist:"34 km",  rating:4.8, sales:240, organic:true,  verified:true,  harvest:"2 days ago", country:"KE", stockQty:48,  bio:"Third-generation avocado farmer tending 2 acres along the Kilifi coast. KEPHIS-certified, zero-pesticide cultivation.", traceability:"KE-KLF-2026-0041", farmerPhone:"+254712001001", wholesale:[{minQty:10,price:6800},{minQty:50,price:6200}], marketPrice:9200,  videoUrl:"https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4" },
{ id:2, emoji:"🍅", name:"Roma Tomatoes",  tzsPrice:25800, unit:"KG",    farmer:"Baba Juma",     farm:"Morogoro Farm, Morogoro",       dist:"88 km",  rating:4.6, sales:512, organic:false, verified:true,  harvest:"Yesterday",  country:"TZ", stockQty:120, bio:"Baba Juma runs a 5-acre plot in the fertile Morogoro foothills. Harvested twice weekly at the Ubungo hub by 6 AM.", traceability:"TZ-MRG-2026-0117", farmerPhone:"+255712002002", wholesale:[{minQty:20,price:23000},{minQty:100,price:20000}], marketPrice:32000, videoUrl:"https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerEscapes.mp4" },
{ id:3, emoji:"🥬", name:"Sukuma Wiki",    tzsPrice:17200, unit:"Bunch", farmer:"Grace Ndungu",  farm:"Limuru Farm, Kiambu",           dist:"12 km",  rating:4.9, sales:890, organic:true,  verified:true,  harvest:"Today",      country:"KE", stockQty:4,   bio:"Grace began farming collard greens 8 years ago. Now supplies 6 restaurants and 120 households weekly from her peri-urban plot near Limuru.", traceability:"KE-KMB-2026-0203", farmerPhone:"+254722003003", marketPrice:21500 },
{ id:4, emoji:"🌽", name:"Sweet Maize",    tzsPrice:53700, unit:"Crate", farmer:"John Otieno",   farm:"Kisumu Farm, Kisumu",           dist:"56 km",  rating:4.5, sales:134, organic:false, verified:false, harvest:"3 days ago", country:"KE", stockQty:0,   bio:"John is a first-generation commercial farmer growing sweet maize for the Nairobi market. Awaiting KEPHIS certification.", traceability:"KE-KSM-2026-0088", farmerPhone:"+254733004004", wholesale:[{minQty:5,price:50000},{minQty:20,price:46000}], marketPrice:68000 },
{ id:5, emoji:"🧅", name:"Red Onions",     tzsPrice:38700, unit:"KG",    farmer:"Fatuma Hassan", farm:"Arusha Farm, Arusha",           dist:"120 km", rating:4.7, sales:305, organic:false, verified:true,  harvest:"4 days ago", country:"TZ", stockQty:300, bio:"Fatuma's family farm near Mount Meru has supplied Arusha markets for two decades. TBS-certified.", traceability:"TZ-ARU-2026-0066", farmerPhone:"+255765005005", wholesale:[{minQty:25,price:35000},{minQty:100,price:31000}], marketPrice:47500, videoUrl:"https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/SubaruOutbackOnStreetAndDirt.mp4" },
{ id:6, emoji:"🍠", name:"Sweet Potato",   tzsPrice:20400, unit:"KG",    farmer:"Peter Mwangi",  farm:"Nakuru Farm, Nakuru",           dist:"28 km",  rating:4.4, sales:178, organic:true,  verified:true,  harvest:"2 days ago", country:"KE", stockQty:2,   bio:"Peter intercropped sweet potatoes with beans using regenerative methods. Certified organic by KOAN.", traceability:"KE-NKR-2026-0154", farmerPhone:"+254722006006", marketPrice:25000 },
{ id:7, emoji:"🥦", name:"Broccoli",       tzsPrice:14500, unit:"KG",    farmer:"Amina Mtui",    farm:"Kilimanjaro Farm, Moshi",       dist:"45 km",  rating:4.6, sales:203, organic:true,  verified:true,  harvest:"Today",      country:"TZ", stockQty:85,  bio:"Amina grows highland broccoli on the cool slopes of Kilimanjaro at 1,600 m. Certified organic by TOAM. Harvested pre-dawn and delivered same day.", traceability:"TZ-MSH-2026-0201", farmerPhone:"+255783007007", wholesale:[{minQty:10,price:13000},{minQty:50,price:11500}], marketPrice:19000 },
{ id:8, emoji:"🧄", name:"Garlic",         tzsPrice:31200, unit:"KG",    farmer:"Hassan Mkwawa",  farm:"Iringa Farm, Iringa",          dist:"67 km",  rating:4.5, sales:167, organic:false, verified:true,  harvest:"3 days ago", country:"TZ", stockQty:167, bio:"Hassan's family has farmed garlic in the Iringa highlands for three generations. TBS-certified, sun-dried post-harvest for extended shelf life.", traceability:"TZ-IRG-2026-0089", farmerPhone:"+255712008008", wholesale:[{minQty:10,price:28500},{minQty:50,price:25000}], marketPrice:38000 },
{ id:9, emoji:"🍋", name:"Limons (Limes)", tzsPrice:9800,  unit:"KG",    farmer:"Zaina Hamisi",  farm:"Zanzibar Farm, Unguja",         dist:"22 km",  rating:4.8, sales:421, organic:true,  verified:true,  harvest:"Yesterday",  country:"TZ", stockQty:3,   bio:"Zaina tends a spice-and-citrus smallholding on Unguja island. Her Persian limes are hand-picked and washed in fresh well water — zero chemical use.", traceability:"TZ-ZNZ-2026-0312", farmerPhone:"+255765009009", marketPrice:13500 },
];

const SHIPS_INIT = [
{ id:"SHP-001", farmer:"Mama Zawadi",  product:"Hass Avocados 40 KG",   emoji:"🥑", status:"qc",      hub:"Westlands Hub" },
{ id:"SHP-002", farmer:"Grace Ndungu", product:"Sukuma Wiki 80 Bunches", emoji:"🥬", status:"green",   hub:"Westlands Hub" },
{ id:"SHP-003", farmer:"Baba Juma",    product:"Roma Tomatoes 60 KG",    emoji:"🍅", status:"pending", hub:"Ubungo Hub" },
{ id:"SHP-004", farmer:"Peter Mwangi", product:"Sweet Potato 50 KG",     emoji:"🍠", status:"transit", hub:"Westlands Hub" },
];
const SMETA = {
pending:{ label:"Awaiting Drop-off",   cls:"sp", icon:"⏳" },
qc:     { label:"Under QC Inspection", cls:"sq", icon:"🔬" },
green:  { label:"Green-lit ✔",         cls:"sg", icon:"✅" },
transit:{ label:"Out for Delivery",    cls:"st", icon:"🚴" },
};

const RIDERS_DATA = [
{ id:"R01", name:"Juma Mwangi",   phone:"+255 712 001 234", vehicle:"Motorbike", zone:"Ubungo / Kinondoni",    rating:4.8, deliveries:312, online:true  },
{ id:"R02", name:"Amina Saleh",   phone:"+255 765 002 345", vehicle:"Bicycle",   zone:"Ilala / Kariakoo",       rating:4.6, deliveries:187, online:true  },
{ id:"R03", name:"David Ochieng", phone:"+254 722 003 456", vehicle:"Motorbike", zone:"Westlands / Kilimani",   rating:4.9, deliveries:524, online:false },
{ id:"R04", name:"Fatuma Ali",    phone:"+255 783 004 567", vehicle:"E-Bike",    zone:"Temeke / Mbagala",       rating:4.7, deliveries:243, online:true  },
{ id:"R05", name:"Peter Kariuki", phone:"+254 733 005 678", vehicle:"Van",       zone:"Karen / Langata",        rating:4.5, deliveries:98,  online:true  },
];

const ORDERS_INIT = [
{ id:"ORD-2601", customer:"Alice Mgeni",      address:"Mikocheni B, Dar es Salaam", hub:"Ubungo Hub",    products:[{emoji:"🥑",name:"Hass Avocados",qty:"3 KG"},{emoji:"🥬",name:"Sukuma Wiki",qty:"2 Bunches"}], total:46500,  status:"available",  riderId:null,  dist:"4.2 km", time:"~18 min", priority:"high",   placed:"10:15 AM", country:"TZ" },
{ id:"ORD-2602", customer:"Brian Otieno",     address:"South C, Nairobi",           hub:"Westlands Hub", products:[{emoji:"🌽",name:"Sweet Maize",qty:"1 Crate"}],                                             total:55900,  status:"assigned",   riderId:"R03", dist:"6.8 km", time:"~28 min", priority:"normal", placed:"10:42 AM", country:"KE" },
{ id:"ORD-2603", customer:"Clara Hassan",     address:"Kariakoo, Dar es Salaam",    hub:"Ubungo Hub",    products:[{emoji:"🍅",name:"Roma Tomatoes",qty:"5 KG"},{emoji:"🧅",name:"Red Onions",qty:"2 KG"}],    total:168000, status:"picked-up",  riderId:"R01", dist:"2.1 km", time:"~9 min",  priority:"normal", placed:"09:55 AM", country:"TZ" },
{ id:"ORD-2604", customer:"Daniel Kimani",    address:"Kilimani, Nairobi",          hub:"Westlands Hub", products:[{emoji:"🍠",name:"Sweet Potato",qty:"4 KG"}],                                               total:83800,  status:"delivered",  riderId:"R03", dist:"3.5 km", time:"Done",    priority:"normal", placed:"08:30 AM", country:"KE" },
{ id:"ORD-2605", customer:"Esther Nyambura",  address:"Temeke, Dar es Salaam",      hub:"Ubungo Hub",    products:[{emoji:"🥑",name:"Hass Avocados",qty:"2 KG"},{emoji:"🍅",name:"Roma Tomatoes",qty:"3 KG"}], total:127100, status:"available",  riderId:null,  dist:"7.6 km", time:"~32 min", priority:"high",   placed:"11:05 AM", country:"TZ" },
{ id:"ORD-2606", customer:"Frank Mwenda",     address:"Langata, Nairobi",           hub:"Westlands Hub", products:[{emoji:"🌽",name:"Sweet Maize",qty:"2 Crates"},{emoji:"🥬",name:"Sukuma Wiki",qty:"4 Bunches"}], total:176200, status:"assigned", riderId:"R05", dist:"5.1 km", time:"~22 min", priority:"normal", placed:"11:20 AM", country:"KE" },
];

const STATUS_LABELS = {
available:  { label:"Available",  cls:"ds-available", icon:"🟢" },
assigned:   { label:"Assigned",   cls:"ds-assigned",  icon:"🟡" },
"picked-up":{ label:"Picked Up",  cls:"ds-picked-up", icon:"🔵" },
delivered:  { label:"Delivered",  cls:"ds-delivered", icon:"✅" },
cancelled:  { label:"Cancelled",  cls:"ds-cancelled", icon:"❌" },
};

// Product filter chips — static, module-level (was inside App() re-creating on every render)
const PRODUCT_FILTERS = ["All", "Organic", "Verified", "< 30 km", "< 60 km", "❤️ Saved", "Wholesale"];

const NAV_TABS = [
{ id:"market",    icon:"🛒", label:"Market"    },
{ id:"portal",    icon:"🌱", label:"Farmer"    },
{ id:"hub",       icon:"🏭", label:"Hub"       },
{ id:"rider",     icon:"🚴", label:"Rider"     },
{ id:"agripass",  icon:"🔬", label:"AgriPass"  },
{ id:"analytics", icon:"📊", label:"Analytics" },
{ id:"herd",      icon:"🐄", label:"HerdPass"  },
];

// ─── Role-based access control ──────────────────────────────────────────────────────
const ROLES = {
customer:  { label:"Customer",    icon:"🛒", tabs:["market","agripass"],                                  color:"#2d6a4f" },
farmer:    { label:"Farmer",      icon:"🌱", tabs:["market","portal","agripass","herd"],                   color:"#1a5c36" },
rider:     { label:"Rider",       icon:"🚴", tabs:["market","rider"],                                      color:"#0c5460" },
inspector: { label:"Inspector",   icon:"🔬", tabs:["market","agripass","hub"],                             color:"#5c3d1e" },
admin:     { label:"Admin",       icon:"🛠️", tabs:["market","portal","hub","rider","agripass","analytics","herd"], color:"#1a3a2a" },
};

// ─── Analytics — self-contained event bus (no external libraries) ────────────────────
//
// This module is zero-dependency so it works in every environment:
// the Claude artifact sandbox, a plain <script> tag, and bundled projects alike.
//
// WHAT IT DOES (sandbox / demo mode):
//   • Keeps a capped in-memory event log (last 200 events)
//   • Logs every event to console.debug so you can inspect in DevTools
//   • POSTs exceptions to your backend /api/errors when API_BASE is set
//   • Exposes window.__asfAnalytics for inspection: open DevTools → Console → window.__asfAnalytics
//
// HOW TO ADD REAL SENTRY + POSTHOG (your deployed Vite / CRA / Next.js project):
//   1. npm install @sentry/react posthog-js
//   2. At the top of this file add:
//        import * as Sentry from "@sentry/react";
//        import posthog from "posthog-js";
//   3. Inside analytics.init(), after "this._ready = true;", add:
//        Sentry.init({ dsn: SENTRY_DSN, environment: "production", tracesSampleRate: 0.2 });
//        this._Sentry = Sentry;
//        posthog.init(POSTHOG_KEY, { api_host: POSTHOG_HOST, autocapture: false, capture_pageview: false });
//        this._posthog = posthog;
//   4. Uncomment the three "Wire:" lines in capture(), identify(), captureException() below.
//
// ── Event taxonomy ──
//   auth.*        Login / logout       cart.*      Add, remove, qty
//   checkout.*    Payment funnel       farmer.*    Listing creation
//   agripass.*    Inspections          error.*     Crashes & API failures
//   $pageview     Tab navigation

const APP_VERSION  = "2.0.0";  // bump on each release
const SENTRY_DSN   = import.meta.env.VITE_SENTRY_DSN || "";
const POSTHOG_KEY  = "";  // ← paste when deploying outside sandbox
const POSTHOG_HOST = "https://app.posthog.com";

const analytics = {
_ready:   false,
_userId:  null,
_log:     [],        // bounded in-memory event buffer
_MAX_LOG: 200,
_Sentry:  null,      // set by init() in a bundled project
_posthog: null,      // set by init() in a bundled project

init() {
if (this._ready) return;
this._ready = true;
// Expose event log on window for DevTools inspection
try { window.__asfAnalytics = this._log; } catch {}
// Wire real SDKs here when deploying outside the sandbox (see instructions above)
log.debug("[Analytics] ready — events logged to window.__asfAnalytics");
// PRODUCTION: uncomment the 6 lines below after: npm install @sentry/react posthog-js
// import * as Sentry from "@sentry/react"; import posthog from "posthog-js";
// Sentry.init({ dsn: SENTRY_DSN, environment: API_BASE ? "production" : "demo", tracesSampleRate: 0.2 });
// this._Sentry = Sentry;
// posthog.init(POSTHOG_KEY, { api_host: POSTHOG_HOST, autocapture: false, capture_pageview: false });
// this._posthog = posthog;
},

identify(userId, traits = {}) {
this._userId = userId;
this._push("identify", { userId, ...traits });
// Wire: if (this._posthog) this._posthog.identify(userId, { ...traits, app: "asiel-farm-shop" });
},

capture(event, properties = {}) {
const entry = {
...properties,
userId: this._userId,
env:    API_BASE ? "production" : "demo",
ts:     new Date().toISOString(),
};
this._push(event, entry);
log.debug("[Analytics]", event, entry);
// Wire: if (this._posthog) this._posthog.capture(event, entry);
},

captureException(error, context = {}) {
const entry = {
message: error?.message || String(error),
stack:   error?.stack,
...context,
userId:  this._userId,
ts:      new Date().toISOString(),
};
this._push("error.captured", entry);
log.error("[Analytics] exception:", entry.message, context);
// Wire: if (this._Sentry) this._Sentry.withScope(s => { s.setUser({ id: this._userId }); s.setExtras(context); this._Sentry.captureException(error); });

// POST to backend /api/errors when API_BASE is set (no external dep — pure fetch)
if (API_BASE) {
  fetch(`${API_BASE}/api/errors`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(entry),
  }).catch(err => log.warn("[analytics] error report failed:", err.message));
}

},

pageView(tab, properties = {}) {
this.capture("$pageview", { tab, ...properties });
},

_push(event, data) {
this._log.push({ event, data, ts: Date.now() });
if (this._log.length > this._MAX_LOG) this._log.shift();
},
};

// ─── Internationalisation (i18n) ────────────────────────────────────────────────────
//
// Lightweight i18n without a library — a flat key→string lookup with:
//   • English (en) — default / fallback
//   • Swahili (sw) — Tanzania pilot primary language
//
// Usage inside any component:
//   const { t } = useTranslation();
//   <h1>{t("hero.title")}</h1>
//
// Adding a new language: add a new top-level key (e.g. "fr") that mirrors "en".
// Adding a new string: add to BOTH en and sw (and any other languages).
//
// In production: swap the flat dicts below for react-i18next with JSON locale files.

const TRANSLATIONS = {
en: {
// Navigation
"nav.market":       "Market",
"nav.farmer":       "Farmer",
"nav.hub":          "Hub",
"nav.rider":        "Rider",
"nav.agripass":     "AgriPass",
"nav.analytics":    "Analytics",
"nav.signout":      "Sign Out",
// Hero
"hero.tag":         "Farm-to-Fork",
"hero.title":       "Fresh from the farm, delivered to your door.",
"hero.subtitle":    "Direct from verified farmers — no middlemen, full traceability.",
"hero.search.placeholder": "Search crops, farmers, locations...",
"hero.search.btn":  "Search",
// Market
"market.listings":  "Listings",
"market.loading":   "Loading...",
"market.no_results":"No results found",
"market.no_results_sub": "Try clearing your filters or searching for a different crop or farmer name.",
"market.clear_filters": "Clear Filters",
"market.add":       "+ Add",
"market.in_cart":   "✓ In Cart",
"market.sold_out":  "Sold Out",
// Cart
"cart.title":       "Cart",
"cart.empty":       "Your cart is empty.\nBrowse fresh listings!",
"cart.subtotal":    "Subtotal (est.)",
"cart.delivery":    "Hub & Delivery",
"cart.total":       "Total",
"cart.checkout":    "🔒 Checkout",
"cart.coupon.placeholder": "e.g. FRESH10, FIRSTBUY...",
"cart.coupon.apply":"Apply",
"cart.weight_note": "⚖️ Weighted estimate — all charges settled in TZS",
// Auth
"auth.title":       "Asiel Farm Shop",
"auth.phone.hint":  "Enter your mobile number to receive a one-time code",
"auth.send_code":   "Send Code →",
"auth.verify":      "Verify & Continue →",
"auth.resend":      "Resend code",
"auth.role.hint":   "Select your role",
// Checkout / Payment
"pay.title":        "Secure Checkout",
"pay.express":      "⚡ Express Pay",
"pay.methods":      "Payment Methods",
"pay.confirm":      "🔒 Pay",
"pay.address.label":"📍 Delivery Address",
// Farmer portal
"portal.title":     "Post My Harvest 🌾",
"portal.submit":    "🚀 Submit Listing to Hub",
"portal.wallet":    "💳 Your Wallet",
"portal.photo":     "📸 Harvest Photos",
"portal.listing":   "📋 Listing Details",
// General
"general.loading":  "Loading...",
"general.demo":     "Demo mode",
"general.back":     "← Back",
// Toasts
"toast.added_to_cart":   "🛒 Added to cart!",
"toast.removed":         "Item removed",
"toast.restored":        "↩️ Item restored!",
"toast.order_placed":    "🎉 Order placed successfully!",
"toast.review_thanks":   "⭐ Thank you for your review!",
"toast.listing_sub":     "✅ Listing submitted!",
"toast.coupon_applied":  "🎟️ Coupon applied!",
"toast.loyalty_earned":  "⭐ loyalty points earned!",
"toast.offline":         "📵 Offline — changes saved locally.",
"toast.online":          "🌐 Back online — syncing data...",
"toast.sold_out":        "❌ Sorry — this item is sold out.",
"toast.order_accepted":  "✅ Order accepted!",
"toast.picked_up":       "📦 Picked up — en route!",
"toast.delivered":       "🎉 Delivery complete!",
"toast.rider_assigned":  "🚴 Rider assigned!",
"toast.wait":            "⏳ Please wait before submitting again.",
"toast.fill_fields":     "⚠️ Please fill in all required fields",
"toast.location_set":    "📍 Location confirmed",
"toast.geo_blocked":     "📍 Demo location set — real GPS blocked in sandbox.",
"toast.geo_unsupported": "📍 Geolocation not supported on this device.",
// AgriPass
"ap.tab.inspector":  "🔍 Inspector",
"ap.tab.mine":       "👤 My Submissions",
"ap.tab.submit":     "📤 Submit Produce",
"ap.inspect_btn":    "🔍 Inspect & Grade",
"ap.view_cert":      "📄 View Certificate & QR",
"ap.submit_btn":     "📤 Submit Batch for Inspection",
"ap.approved":       "✅ Approved",
"ap.rejected":       "❌ Rejected",
"ap.pending":        "⏳ In Queue",
"ap.submission_rx":  "📤 Submission received — queued for inspection!",
"ap.fill_required":  "⚠️ Fill in all required fields",
"ap.approved_toast": "✅ Produce approved — certificate issued!",
"ap.rejected_toast": "❌ Produce rejected — farmer notified.",
// Farmer onboarding wizard
"ob.progress":         "Step {n} of {total}",
"ob.next":             "Next →",
"ob.back":             "← Back",
"ob.submit":           "Submit for Review",
"ob.skip_location":    "Skip — set location later",
"ob.detecting":        "Detecting your location…",
"ob.detect_btn":       "📍 Detect My Location",
"ob.pending_title":    "Profile Under Review",
"ob.pending_sub":      "Our team reviews all new farmers within 24 hours. You will receive an SMS once approved.",
"ob.approved_title":   "You're Approved! 🎉",
"ob.approved_sub":     "Welcome to Asiel Farm Shop. You can now post listings.",
"ob.start_listing":    "Start Listing Produce",
"ob.s0.title":         "Welcome, Farmer!",
"ob.s0.sub":           "We need a few details to set up your seller profile. It takes about 3 minutes.",
"ob.s0.begin":         "Get Started",
"ob.s1.title":         "Your Identity",
"ob.s1.name":          "Full legal name",
"ob.s1.name_ph":       "As on your national ID",
"ob.s1.id":            "National ID number",
"ob.s1.id_ph":         "NIDA / Huduma number",
"ob.s2.title":         "Your Farm",
"ob.s2.farm_name":     "Farm or trading name",
"ob.s2.farm_name_ph":  "e.g. Kilima Fresh Farm",
"ob.s2.region":        "Region / County",
"ob.s2.region_ph":     "Select region",
"ob.s2.size":          "Farm size",
"ob.s3.title":         "Farm Location",
"ob.s3.sub":           "Helps us match you with nearby buyers and hubs.",
"ob.s4.title":         "What Do You Grow?",
"ob.s4.sub":           "Select all crops you grow regularly.",
"ob.s4.method":        "Farming method",
"ob.s4.organic":       "Certified Organic",
"ob.s4.conventional":  "Conventional",
"ob.s4.mixed":         "Mixed",
"ob.s4.year_round":    "Do you supply year-round?",
"ob.s4.yes":           "Yes — year-round",
"ob.s4.no":            "No — seasonal",
"ob.s5.title":         "Delivery & Storage",
"ob.s5.hub":           "Can you deliver to a collection hub?",
"ob.s5.cold":          "Do you have cool / cold storage on-farm?",
"ob.s5.max_kg":        "Maximum weekly supply (KG)",
"ob.s5.max_kg_ph":     "e.g. 500",
"ob.s6.title":         "Payout Details",
"ob.s6.sub":           "How should we send your earnings?",
"ob.s6.method":        "Preferred payout method",
"ob.s6.phone":         "Mobile money number for payouts",
"ob.s6.phone_ph":      "e.g. +255 712 345 678",
"ob.s6.bank_note":     "Our team will contact you for bank account details.",
"ob.s7.title":         "Review & Submit",
"ob.s7.sub":           "Check your details before submitting.",
"ob.s7.edit":          "Edit",
},

sw: {
// Urambazaji
"nav.market":       "Soko",
"nav.farmer":       "Mkulima",
"nav.hub":          "Kituo",
"nav.rider":        "Mpelekaji",
"nav.agripass":     "AgriPass",
"nav.analytics":    "Takwimu",
"nav.signout":      "Toka",
// Ukurasa Mkuu
"hero.tag":         "Shamba hadi Mezani",
"hero.title":       "Mazao mapya kutoka shambani, yaliyoletwa mlangoni mwako.",
"hero.subtitle":    "Moja kwa moja kutoka kwa wakulima waliothibitishwa — bila wasichana wa kati.",
"hero.search.placeholder": "Tafuta mazao, wakulima, maeneo...",
"hero.search.btn":  "Tafuta",
// Soko
"market.listings":  "Orodha",
"market.loading":   "Inapakia...",
"market.no_results":"Hakuna matokeo",
"market.no_results_sub": "Jaribu kufuta vichujio au kutafuta jina tofauti la zao au mkulima.",
"market.clear_filters": "Futa Vichujio",
"market.add":       "+ Ongeza",
"market.in_cart":   "✓ Kwenye Kapu",
"market.sold_out":  "Imeisha",
// Kapu
"cart.title":       "Kapu",
"cart.empty":       "Kapu lako liko tupu.\nTafuta mazao mapya!",
"cart.subtotal":    "Jumla ndogo (est.)",
"cart.delivery":    "Kituo & Uwasilishaji",
"cart.total":       "Jumla",
"cart.checkout":    "🔒 Lipia",
"cart.coupon.placeholder": "mfano FRESH10, FIRSTBUY...",
"cart.coupon.apply":"Tumia",
"cart.weight_note": "⚖️ Kadirio — malipo yote yatalipwa kwa TZS",
// Uthibitishaji
"auth.title":       "Asiel Farm Shop",
"auth.phone.hint":  "Ingiza nambari yako ya simu ili upokee nambari ya mara moja",
"auth.send_code":   "Tuma Nambari →",
"auth.verify":      "Thibitisha & Endelea →",
"auth.resend":      "Tuma tena nambari",
"auth.role.hint":   "Chagua jukumu lako",
// Malipo
"pay.title":        "Malipo Salama",
"pay.express":      "⚡ Lipia Haraka",
"pay.methods":      "Njia za Malipo",
"pay.confirm":      "🔒 Lipia",
"pay.address.label":"📍 Anwani ya Uwasilishaji",
// Mkulima
"portal.title":     "Tuma Mavuno Yangu 🌾",
"portal.submit":    "🚀 Tuma Orodha Kituo",
"portal.wallet":    "💳 Pochi Yangu",
"portal.photo":     "📸 Picha za Mavuno",
"portal.listing":   "📋 Maelezo ya Orodha",
// Jumla
"general.loading":  "Inapakia...",
"general.demo":     "Hali ya majaribio",
"general.back":     "← Rudi",
// Arifa (Toasts)
"toast.added_to_cart":   "🛒 Kimeongezwa kwenye kapu!",
"toast.removed":         "Kimeondolewa",
"toast.restored":        "↩️ Kimerejesha!",
"toast.order_placed":    "🎉 Agizo limewekwa!",
"toast.review_thanks":   "⭐ Asante kwa maoni yako!",
"toast.listing_sub":     "✅ Orodha imetumwa!",
"toast.coupon_applied":  "🎟️ Kuponi imetumika!",
"toast.loyalty_earned":  "⭐ pointi za uaminifu zimepatikana!",
"toast.offline":         "📵 Nje ya mtandao — mabadiliko yamehifadhiwa.",
"toast.online":          "🌐 Umepata mtandao — inapatanisha...",
"toast.sold_out":        "❌ Samahani — bidhaa hii imeisha.",
"toast.order_accepted":  "✅ Agizo limekubaliwa!",
"toast.picked_up":       "📦 Imechukuliwa — safarini!",
"toast.delivered":       "🎉 Uwasilishaji umekamilika!",
"toast.rider_assigned":  "🚴 Mpelekaji amepewa!",
"toast.wait":            "⏳ Tafadhali subiri kabla ya kuwasilisha tena.",
"toast.fill_fields":     "⚠️ Jaza sehemu zote zinazohitajika",
"toast.location_set":    "📍 Mahali pamethibitishwa",
"toast.geo_blocked":     "📍 GPS imezuiwa — kutumia eneo la majaribio.",
"toast.geo_unsupported": "📍 Eneo halitumiki kwenye kifaa hiki.",
// AgriPass
"ap.tab.inspector":  "🔍 Mkaguzi",
"ap.tab.mine":       "👤 Maombi Yangu",
"ap.tab.submit":     "📤 Tuma Mazao",
"ap.inspect_btn":    "🔍 Kagua na Pima",
"ap.view_cert":      "📄 Angalia Cheti & QR",
"ap.submit_btn":     "📤 Tuma Kundi kwa Ukaguzi",
"ap.approved":       "✅ Imeidhinishwa",
"ap.rejected":       "❌ Imekataliwa",
"ap.pending":        "⏳ Foleni",
"ap.submission_rx":  "📤 Ombi limepokelewa — foleni ya ukaguzi!",
"ap.fill_required":  "⚠️ Jaza sehemu zote zinazohitajika",
"ap.approved_toast": "✅ Mazao yameidhinishwa — cheti kimetolewa!",
"ap.rejected_toast": "❌ Mazao yamekataliwa — mkulima amearifiwa.",
// Farmer onboarding wizard
"ob.progress":         "Hatua {n} ya {total}",
"ob.next":             "Endelea →",
"ob.back":             "← Rudi",
"ob.submit":           "Wasilisha kwa Mapitio",
"ob.skip_location":    "Ruka — weka eneo baadaye",
"ob.detecting":        "Inatambua eneo lako…",
"ob.detect_btn":       "📍 Gundua Eneo Langu",
"ob.pending_title":    "Wasifu Unakaguliwa",
"ob.pending_sub":      "Timu yetu inakagua wakulima wapya ndani ya saa 24. Utapokea SMS ukikubaliwa.",
"ob.approved_title":   "Umeidhinishwa! 🎉",
"ob.approved_sub":     "Karibu Asiel Farm Shop. Sasa unaweza kuorodhesha mazao.",
"ob.start_listing":    "Anza Kuorodhesha Mazao",
"ob.s0.title":         "Karibu, Mkulima!",
"ob.s0.sub":           "Tunahitaji maelezo machache kuanzisha wasifu wako wa muuzaji. Itachukua dakika 3.",
"ob.s0.begin":         "Anza",
"ob.s1.title":         "Utambulisho Wako",
"ob.s1.name":          "Jina kamili la kisheria",
"ob.s1.name_ph":       "Kama kwenye kitambulisho chako",
"ob.s1.id":            "Nambari ya kitambulisho",
"ob.s1.id_ph":         "Nambari ya NIDA / Huduma",
"ob.s2.title":         "Shamba Lako",
"ob.s2.farm_name":     "Jina la shamba au biashara",
"ob.s2.farm_name_ph":  "mfano: Kilima Fresh Farm",
"ob.s2.region":        "Mkoa / Kaunti",
"ob.s2.region_ph":     "Chagua mkoa",
"ob.s2.size":          "Ukubwa wa shamba",
"ob.s3.title":         "Mahali pa Shamba",
"ob.s3.sub":           "Inasaidia kuunganisha na wanunuzi na vituo vya karibu.",
"ob.s4.title":         "Unalima Nini?",
"ob.s4.sub":           "Chagua mazao yote unayolima mara kwa mara.",
"ob.s4.method":        "Mbinu ya kilimo",
"ob.s4.organic":       "Kilimo Hai Kilichoidhinishwa",
"ob.s4.conventional":  "Kilimo cha Kawaida",
"ob.s4.mixed":         "Mchanganyiko",
"ob.s4.year_round":    "Je, unasambaza mwaka mzima?",
"ob.s4.yes":           "Ndiyo — mwaka mzima",
"ob.s4.no":            "La — kwa msimu",
"ob.s5.title":         "Usafirishaji & Uhifadhi",
"ob.s5.hub":           "Je, unaweza kuleta mazao kwenye kituo cha mkusanyiko?",
"ob.s5.cold":          "Je, una ghala la baridi shambani?",
"ob.s5.max_kg":        "Uzalishaji wa juu kwa wiki (KG)",
"ob.s5.max_kg_ph":     "mfano 500",
"ob.s6.title":         "Maelezo ya Malipo",
"ob.s6.sub":           "Tungependa kukulipa vipi?",
"ob.s6.method":        "Njia ya malipo unayopendelea",
"ob.s6.phone":         "Nambari ya pesa ya simu kwa malipo",
"ob.s6.phone_ph":      "mfano +255 712 345 678",
"ob.s6.bank_note":     "Timu yetu itawasiliana nawe kwa maelezo ya benki.",
"ob.s7.title":         "Kagua na Wasilisha",
"ob.s7.sub":           "Angalia maelezo yako kabla ya kutuma.",
"ob.s7.edit":          "Hariri",
},
};

// Default language — TZ pilot launches in Swahili
const DEFAULT_LANG = "sw";

// Translation context
const TranslationContext = React.createContext({ t: k => k, lang: DEFAULT_LANG });

// useTranslation — returns { t, lang, setLang }
// t(key, fallback?) → translated string or key if missing
function useTranslation() {
return React.useContext(TranslationContext);
}

// TranslationProvider — wraps the app, provides language state
function TranslationProvider({ children }) {
const [lang, setLang] = useState(() => {
const saved = localStorage.getItem("asf_lang");
return saved && TRANSLATIONS[saved] ? saved : DEFAULT_LANG;
});

const t = useCallback((key, fallback) => {
const dict = TRANSLATIONS[lang] ?? TRANSLATIONS.en;
return dict[key] ?? TRANSLATIONS.en[key] ?? fallback ?? key;
}, [lang]);

const changeLang = useCallback(l => {
setLang(l);
localStorage.setItem("asf_lang", l);
analytics.capture("i18n.language_changed", { from: lang, to: l });
}, [lang]);

return (
<TranslationContext.Provider value={{ t, lang, setLang: changeLang }}>
{children}
</TranslationContext.Provider>
);
}

// ─── State persistence ────────────────────────────────────────────────────────────────
//
// Two-tier strategy:
//   Tier 1 — localStorage (immediate, always)
//     • Survives page refresh within the same browser/device
//     • Falls back automatically when offline or when API_BASE is empty
//
//   Tier 2 — Backend (debounced, when authenticated)
//     • Survives device changes, incognito tabs, and cache clears
//     • Triggered by hydrateFromBackend() on login and by debouncedBackendSync() on change
//
// Data that syncs to backend: cart, qty, loyaltyPts, country, currency, consentGiven
// Data that stays local only: userRole (comes from JWT), apSubmissions (local QC queue)

const STORAGE_KEY = "asiel_farm_shop_v2"; // bump version to clear stale localStorage on major updates
let stateCache = null;

function loadState() {
try {
const raw    = localStorage.getItem(STORAGE_KEY);
const parsed = raw ? JSON.parse(raw) : null;
if (parsed) stateCache = parsed;
return parsed;
} catch { return null; }
}

function saveState(slice) {
try {
stateCache = { ...(stateCache ?? {}), ...slice, _savedAt: Date.now() };
localStorage.setItem(STORAGE_KEY, JSON.stringify(stateCache));
} catch (e) { log.warn("[saveState] localStorage write failed:", e.message); }
}

// hydrateFromBackend — called once after successful OTP login.
// Fetches the server-side profile and merges it into localStorage so
// the app immediately reflects the user's state from any previous device.
async function hydrateFromBackend(setters) {
if (!tokenStore.get()) return;  // not logged in
try {
const profile = await apiService.getProfile();
if (!profile) return;

// Merge server state — server wins for loyalty and preferences,
// but we merge carts (union of local + server items)
const localCart  = loadState()?.cart || [];
const serverCart = profile.cart      || [];
const mergedCart = [...serverCart];
localCart.forEach(item => {
  if (!mergedCart.some(s => s.id === item.id)) mergedCart.push(item);
});

// Persist merged state to localStorage
saveState({
  cart:         mergedCart,
  qty:          { ...(profile.qty || {}), ...(loadState()?.qty || {}) },
  loyaltyPts:   Math.max(profile.loyaltyPts ?? 0, loadState()?.loyaltyPts ?? 0),
  country:      profile.country  || loadState()?.country  || "TZ",
  cur:          profile.currency || loadState()?.cur      || "TZS",
  consentGiven: profile.consentGiven ?? loadState()?.consentGiven ?? false,
});

// Push merged state back into React via setters
if (setters) {
  const s = loadState();
  setters.setCart?.(s.cart         ?? []);
  setters.setQty?.(s.qty           ?? {});
  setters.setLoyaltyPts?.(s.loyaltyPts ?? DEFAULT_LOYALTY_PTS);
  setters.setCountry?.(s.country   ?? "TZ");
  setters.setCur?.(s.cur           ?? "TZS");
  setters.setConsentGiven?.(s.consentGiven ?? false);
}

} catch (err) {
log.warn("[hydrateFromBackend] Using local state:", err.message);
}
}

// Debounced backend sync — called from the saveState effect.
// Waits 3 s after the last change before hitting the API to avoid hammering.
let _syncTimer = null;
function scheduledBackendSync(state) {
clearTimeout(_syncTimer);
_syncTimer = setTimeout(async () => {
if (!tokenStore.get()) return;
try {
await Promise.all([
apiService.syncCart(state.cart, state.qty),
apiService.syncLoyalty(state.loyaltyPts),
apiService.syncPreferences({ country: state.country, currency: state.cur, consentGiven: state.consentGiven }),
]);
} catch (err) { console.warn("[sync] backend sync failed:", err.message); }
}, BACKEND_SYNC_DELAY_MS);
}

// ─── API service layer ───────────────────────────────────────────────────────────────
//
// API_BASE is the single config point.
//   • Development / demo  →  leave as "" (empty) → mock fallback is used automatically
//   • Tanzania pilot      →  set to "https://api.asielfarm.tz" (or your Railway URL)
//   • Any real backend    →  just change this one constant; all fetch calls update
//
// PRODUCTION CHECKLIST (do before go-live):
//   ☐ Set API_BASE to your deployed Railway/Render backend URL
//   ☐ Set STRIPE_PK to your real Stripe publishable key
//   ☐ Deploy sw.js to /public/sw.js (Service Worker)
//   ☐ Deploy manifest.json to /public/manifest.json
//   ☐ Add logo-nav.png and logo-hero.png to /public/
//   ☐ Set all .env variables on the backend (see env.example)
//   ☐ Configure Stripe webhook endpoint in Stripe dashboard
//   ☐ Verify TRA VFD partner credentials with NepTech or Camara TZ
//   ☐ Run npm test on backend before first deployment
//
const API_BASE = import.meta.env.VITE_API_BASE || "";

// ─── Social sign-in ───────────────────────────────────────────────────────────
// Set these in .env.production/.env.development — they are public client IDs, not secrets.
const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || "";
const APPLE_CLIENT_ID  = import.meta.env.VITE_APPLE_CLIENT_ID  || "";

// ─── Stripe publishable key ──────────────────────────────────────────────────
// Set VITE_STRIPE_PK in your CI/CD environment — never hardcode the live key.
const STRIPE_PK = import.meta.env.VITE_STRIPE_PK || "pk_test_REPLACE_WITH_YOUR_PUBLISHABLE_KEY";
// loadStripe is called once at module level (Stripe docs requirement).
// In demo mode (no API_BASE) the promise resolves to null — Elements won't mount.
const stripePromise = API_BASE ? loadStripe(STRIPE_PK) : Promise.resolve(null);

// ─── Debug logging ────────────────────────────────────────────────────────────
// Set to true in development. Production builds strip all debug output.
const DEBUG = API_BASE === "" || typeof process !== "undefined" && process.env?.NODE_ENV !== "production";
const log   = { debug: (...a) => DEBUG && console.debug(...a),   // eslint-disable-line
warn:  (...a) => DEBUG && console.warn(...a),    // eslint-disable-line
error: (...a) => console.error(...a) };          // errors always shown

// Centralised request helper — auth header, CSRF token, JSON parse, error logging
// csrfToken: generated server-side on login, stored in React state (never localStorage).
// credentials:"include" sends the httpOnly session cookie automatically.
// ── Token store ─────────────────────────────────────────────────────────────────────
// SECURITY: In production with a real backend, DELETE this entire block and rely
// exclusively on httpOnly session cookies (credentials:"include" below handles that).
// localStorage tokens are readable by any JS on the page — XSS = full account takeover.
// Demo mode uses localStorage only because there is no backend to issue cookies.
const tokenStore = {
  _mem: null,
  get()         { return API_BASE ? this._mem : tokenStore.get(); },
  set(tok)      { if (API_BASE) { this._mem = tok; } else { localStorage.setItem("asf_token", tok); } },
  clear()       { this._mem = null; tokenStore.clear(); },
  exists()      { return !!this.get(); },
};
// In-memory CSRF token — fetched once after login, never persisted.
// Module-level so it survives re-renders without being in React state.
let _csrfToken = "";


async function apiFetch(path, options = {}) {
// Auth strategy:
//   Production (API_BASE set):  httpOnly cookie via credentials:"include" — no localStorage needed.
//   Demo mode (API_BASE empty): localStorage JWT fallback so the demo runs without a backend.
const token = !API_BASE ? tokenStore.get() : null; // demo-mode only
const MUTATION_METHODS = ["POST","PUT","PATCH","DELETE"];
const isMutation = MUTATION_METHODS.includes((options.method || "GET").toUpperCase());
const res = await fetch(`${API_BASE}${path}`, {
credentials: "include",  // sends httpOnly session cookie (production)
headers: {
"Content-Type": "application/json",
...(token ? { Authorization: `Bearer ${token}` } : {}),
// CSRF token on all state-mutating requests — prevents CSRF attacks when using cookies
...(isMutation && _csrfToken ? { "X-CSRF-Token": _csrfToken } : {}),
...options.headers,
},
...options,
});
if (!res.ok) {
const err = await res.json().catch(() => ({ message: res.statusText }));
throw new Error(err.message || `API error ${res.status}`);
}
return res.json();
}

// apiService — every backend endpoint in one place.
// Each method tries the real API first; on failure or when API_BASE is empty
// it falls back to the static mock data so the app keeps working as a demo.
const apiService = {

// ── Products ──────────────────────────────────────────────────────────────────────
async getProducts(country) {
if (!API_BASE) return PRODUCTS.filter(p => p.country === country);
try {
return await apiFetch(`/api/products?country=${country}`);
} catch {
log.warn("[apiService] getProducts: using mock fallback");
return PRODUCTS.filter(p => p.country === country);
}
},

async createListing(listing) {
if (!API_BASE) return { id: `LIST-${Date.now()}`, ...listing, status: "pending_qc" };
return apiFetch("/api/listings", { method: "POST", body: JSON.stringify(listing) });
},

// ── Orders ────────────────────────────────────────────────────────────────────────
async getOrders(country) {
if (!API_BASE) return ORDERS_INIT.filter(o => o.country === country);
try {
return await apiFetch(`/api/orders?country=${country}`);
} catch {
log.warn("[apiService] getOrders: using mock fallback");
return ORDERS_INIT.filter(o => o.country === country);
}
},

async updateOrderStatus(orderId, patch) {
if (!API_BASE) return { id: orderId, ...patch };
return apiFetch(`/api/orders/${orderId}`, { method: "PATCH", body: JSON.stringify(patch) });
},

async placeOrder(orderData) {
if (!API_BASE) return { id: `ORD-${Date.now()}`, ...orderData, status: "available" };
return apiFetch("/api/orders", { method: "POST", body: JSON.stringify(orderData) });
},

// ── Riders ────────────────────────────────────────────────────────────────────────
async getRiders(country) {
if (!API_BASE) return RIDERS_DATA.filter(r => r.phone.startsWith(getCfg(country).dialPrefix));
try {
return await apiFetch(`/api/riders?country=${country}`);
} catch {
log.warn("[apiService] getRiders: using mock fallback");
return RIDERS_DATA;
}
},

// ── Hub shipments ─────────────────────────────────────────────────────────────────
async getShipments(country) {
if (!API_BASE) return SHIPS_INIT;
try {
return await apiFetch(`/api/shipments?country=${country}`);
} catch {
log.warn("[apiService] getShipments: using mock fallback");
return SHIPS_INIT;
}
},

async updateShipmentStatus(shipId, status) {
if (!API_BASE) return { id: shipId, status };
return apiFetch(`/api/shipments/${shipId}`, { method: "PATCH", body: JSON.stringify({ status }) });
},

// ── AgriPass inspections ──────────────────────────────────────────────────────────
async getSubmissions(country) {
if (!API_BASE) return AP_SUBMISSIONS_INIT.filter(s => !s.country || s.country === country);
try {
return await apiFetch(`/api/agripass?country=${country}`);
} catch {
log.warn("[apiService] getSubmissions: using mock fallback");
return AP_SUBMISSIONS_INIT.filter(s => !s.country || s.country === country);
}
},

async submitInspection(submissionId, result) {
if (!API_BASE) return { id: submissionId, ...result };
return apiFetch(`/api/agripass/${submissionId}/inspect`, { method: "PATCH", body: JSON.stringify(result) });
},

async createSubmission(data) {
if (!API_BASE) return { id: secureId("AP"), ...data, status: "pending" };
return apiFetch("/api/agripass", { method: "POST", body: JSON.stringify(data) });
},

// ── Payments ──────────────────────────────────────────────────────────────────────
async initiatePayment({ method, phone, paymentMethodId, amount, currency, orderId, country }) {
if (!API_BASE) {
// Mock: simulate a 2.4 s processing delay then success
await new Promise(r => setTimeout(r, PAYMENT_DEMO_DELAY_MS));
return { status: "success", ref: secureId("SF") };
}
return apiFetch("/api/payments/initiate", {
method: "POST",
body: JSON.stringify({ method, phone, paymentMethodId, amount, currency, orderId, country }),
});
},

async pollPaymentStatus(ref) {
if (!API_BASE) return { status: "success", ref };
return apiFetch(`/api/payments/${ref}/status`);
},

// ── TRA VFD Fiscal Receipt ────────────────────────────────────────────────────────
// Tanzania Revenue Authority Virtual Fiscal Device — required by law for every
// commercial transaction in Tanzania (Electronic Fiscal Device Management System).
//
// In production: your backend calls your certified VFD partner (NepTech or Camara
// Tanzania) who holds TRA type approval and returns a fiscal number + receipt QR.
//
// In demo mode (API_BASE empty): returns a mock receipt with realistic TRA format.
async generateVFD({ orderId, amount, ref, country, paymentMethod }) {
// VFD is only legally required in Tanzania; other countries return null
if (country !== "TZ") return null;

if (!API_BASE) {
  // Realistic mock — matches TRA VFMS receipt format
  await new Promise(r => setTimeout(r, 900)); // simulate API roundtrip
  const fiscalNumber = `TRA-${secureId()}-VFD`;
  return {
    fiscalNumber,
    receiptNumber:  `RCT-${ref}`,
    tin:            "123-456-789",           // Asiel Farm Shop TIN
    businessName:   "Asiel Farm Shop Ltd",
    vrn:            "40-000123-A",           // VAT Registration Number
    amount,
    vat:            Math.round(amount * 0.18), // Tanzania VAT 18%
    issuedAt:       new Date().toISOString(),
    qrUrl:          `https://verify.tra.go.tz/vfd?fn=${fiscalNumber}`,
    qrData:         fiscalNumber,            // used to render QR locally
    status:         "issued",
  };
}

try {
  return await apiFetch("/api/payments/vfd", {
    method: "POST",
    body: JSON.stringify({ orderId, amount, ref, paymentMethod }),
  });
} catch (err) {
  log.error("[apiService] generateVFD failed:", err.message);
  return { status: "error", message: err.message };
}

},

// ── Analytics ─────────────────────────────────────────────────────────────────────
async getAnalytics(country, period) {
if (!API_BASE) return { ...ANALYTICS_DATA, country, period };
try {
return await apiFetch(`/api/analytics?country=${country}&period=${period}`);
} catch {
log.warn("[apiService] getAnalytics: using mock fallback");
return { ...ANALYTICS_DATA, country, period };
}
},

// ── User accounts + cloud persistence ────────────────────────────────────────────
// In production: the backend stores all user state keyed by userId (from JWT).
// On every app load, getProfile() fetches the server-side state and hydrates
// the local cache — so the app works identically on any device.
//
// Demo mode (API_BASE empty): returns mock profile data. localStorage remains
// the fallback so the app stays fully functional without a backend.

async getProfile() {
if (!API_BASE) {
// Return a realistic demo profile
return {
userId:       "demo-user-001",
name:         "Demo User",
phone:        "+255 712 000 000",
role:         null,                   // role comes from OTP verify in production
country:      loadState()?.country || "TZ",
currency:     loadState()?.cur      || "TZS",
loyaltyPts:   loadState()?.loyaltyPts || 240,
cart:         loadState()?.cart      || [],
qty:          loadState()?.qty       || {},
consentGiven: loadState()?.consentGiven || false,
createdAt:    "2026-01-15T08:00:00Z",
};
}
return apiFetch("/api/users/me");
},

async syncCart(cart, qty) {
if (!API_BASE) return;                           // localStorage handles it in demo
try {
await apiFetch("/api/users/me/cart", {
method: "PUT",
body:   JSON.stringify({ cart, qty }),
});
} catch { /* silent — localStorage is the fallback */ }
},

async syncLoyalty(loyaltyPts) {
if (!API_BASE) return;
try {
await apiFetch("/api/users/me/loyalty", {
method: "PATCH",
body:   JSON.stringify({ loyaltyPts }),
});
} catch {}
},

async syncPreferences(prefs) {
// prefs = { country, currency, consentGiven }
if (!API_BASE) return;
try {
await apiFetch("/api/users/me/preferences", {
method: "PATCH",
body:   JSON.stringify(prefs),
});
} catch {}
},

async getOrderHistory(country) {
if (!API_BASE) {
// Return delivered orders as order history
return ORDERS_INIT.filter(o => o.country === country && o.status === "delivered");
}
try {
return await apiFetch(`/api/users/me/orders?country=${country}`);
} catch (err) {
log.warn("[apiService] getUserOrders: using mock fallback:", err.message);
return ORDERS_INIT.filter(o => o.country === country && o.status === "delivered");
}
},
// Production: calls Africa's Talking SMS API via your backend.
// Demo mode (API_BASE empty): simulates a 900ms delay and returns a fixed code
// "123456" so you can test the full flow without a real backend.

async sendOTP(phone, country) {
if (!API_BASE) {
await new Promise(r => setTimeout(r, 900));
return { success: true, demo: true, hint: "Use code 123456" };
}
return apiFetch("/api/auth/otp/send", {
method: "POST",
body: JSON.stringify({ phone, country }),
});
},

async verifyOTP(phone, code) {
if (!API_BASE) {
await new Promise(r => setTimeout(r, 700));
if (code === "123456") {
// Demo mode: role is not server-assigned, so we return null and let
// LoginScreen show the role selector as the final step.
return { success: true, token: "demo-jwt-token", role: null, demo: true };
}
return { success: false, error: "Incorrect code. Please try again." };
}
return apiFetch("/api/auth/otp/verify", {
method: "POST",
body: JSON.stringify({ phone, code }),
});
},

async fetchCsrfToken() {
if (!API_BASE) { _csrfToken = "demo-csrf-token"; return; }
try {
const { csrfToken } = await apiFetch("/api/csrf-token");
_csrfToken = csrfToken || "";
} catch { _csrfToken = ""; }
},

async loginWithGoogle(credential) {
return apiFetch("/api/auth/google", { method: "POST", body: JSON.stringify({ credential }) });
},

async loginWithApple(idToken, user) {
return apiFetch("/api/auth/apple", { method: "POST", body: JSON.stringify({ idToken, user }) });
},

async logout() {
// Remove demo-mode JWT and clear in-memory CSRF token
_csrfToken = "";
tokenStore.clear();
if (!API_BASE) return;
// In production: backend clears the httpOnly session cookie
try { await apiFetch("/api/auth/logout", { method: "POST" }); } catch (err) { log.warn("[apiService] logout:", err.message); }
},

// ── Real-time events (Server-Sent Events) ─────────────────────────────────────────
// In production: your backend streams order/rider/shipment updates as SSE.
// Endpoint: GET /api/events?country=TZ  (streams indefinitely, auth via token)
//
// Event envelope (JSON per line):
//   { type: "order_update",    payload: { id, status, riderId } }
//   { type: "rider_update",    payload: { id, online, zone } }
//   { type: "shipment_update", payload: { id, status } }
//   { type: "ping",            payload: {} }   ← keepalive every 30s
//
// Demo mode (API_BASE empty): emits synthetic events on a 12-second cycle so
// the UI shows live updates without a real backend.
subscribeEvents(country, handlers) {
// handlers: { onOrderUpdate, onRiderUpdate, onShipmentUpdate, onConnected, onDisconnected }
if (!API_BASE) {
// ── Demo simulator ──
// Rotates through a realistic sequence of order/rider/shipment state changes
const demoEvents = [
{ type:"order_update",    payload:{ id:"ORD-2601", status:"assigned",  riderId:"R01" } },
{ type:"rider_update",    payload:{ id:"R03", online:true } },
{ type:"shipment_update", payload:{ id:"SHP-003", status:"qc" } },
{ type:"order_update",    payload:{ id:"ORD-2605", status:"assigned",  riderId:"R04" } },
{ type:"shipment_update", payload:{ id:"SHP-001", status:"green" } },
{ type:"order_update",    payload:{ id:"ORD-2601", status:"picked-up", riderId:"R01" } },
{ type:"rider_update",    payload:{ id:"R02", online:false } },
{ type:"order_update",    payload:{ id:"ORD-2605", status:"picked-up", riderId:"R04" } },
{ type:"shipment_update", payload:{ id:"SHP-003", status:"green" } },
{ type:"order_update",    payload:{ id:"ORD-2601", status:"delivered", riderId:"R01" } },
];
let idx = 0;
handlers.onConnected?.();
const timer = setInterval(() => {
const evt = demoEvents[idx % demoEvents.length];
if (evt.type === "order_update")    handlers.onOrderUpdate?.(evt.payload);
if (evt.type === "rider_update")    handlers.onRiderUpdate?.(evt.payload);
if (evt.type === "shipment_update") handlers.onShipmentUpdate?.(evt.payload);
idx++;
}, DEMO_EVENT_INTERVAL_MS); // one event every 12 seconds
// Return unsubscribe function
return () => { clearInterval(timer); handlers.onDisconnected?.(); };
}

// ── Production: real EventSource ──
// NOTE: EventSource cannot set Authorization headers.
// Production: use session cookie (credentials auto-sent) or a short-lived
// one-time SSE token issued by GET /api/sse-token (expires in 30s).
// NEVER append long-lived auth tokens to the URL — they appear in server logs.
const url = `${API_BASE}/api/events?country=${country}`;
// EventSource sends cookies automatically — backend validates session there.
// If bearer-only auth is used, call GET /api/sse-token first:
// const { sseToken } = await apiFetch("/api/sse-token"); then append &t=${sseToken}
const es  = new EventSource(url, { withCredentials: true });

es.onopen = () => handlers.onConnected?.();
es.onerror = () => {
  handlers.onDisconnected?.();
  // EventSource auto-reconnects — no manual retry needed
};
const SSE_ALLOWED_TYPES = new Set(["order_update","rider_update","shipment_update","rider_location","ping"]);
es.onmessage = e => {
  try {
    const data = JSON.parse(e.data);
    if (!data || typeof data !== "object") return;
    if (!SSE_ALLOWED_TYPES.has(data.type)) {
      console.warn("[SSE] Unknown event type ignored:", data.type); return;
    }
    // Only pass through expected scalar/object fields — no raw payload spread
    if (data.type === "order_update" && data.payload?.id)
      handlers.onOrderUpdate?.({ id: data.payload.id, status: data.payload.status, riderId: data.payload.riderId ?? null });
    if (data.type === "rider_update" && data.payload?.id)
      handlers.onRiderUpdate?.({ id: data.payload.id, lat: Number(data.payload.lat), lng: Number(data.payload.lng), status: data.payload.status });
    if (data.type === "shipment_update" && data.payload?.id)
      handlers.onShipmentUpdate?.({ id: data.payload.id, status: data.payload.status });
    if (data.type === "rider_location" && data.payload?.orderId)
      handlers.onRiderLocation?.({ orderId: data.payload.orderId, lat: Number(data.payload.lat), lng: Number(data.payload.lng) });
  } catch (err) { console.error("[SSE] Parse error:", err.message); }
};

// Return unsubscribe function
return () => {
  // Null out handlers before close to prevent late-firing callbacks
  es.onopen = null; es.onerror = null; es.onmessage = null;
  es.close();
  handlers.onDisconnected?.();
};

},

// ── Push notifications ────────────────────────────────────────────────────────────────
async getVapidKey() {
if (!API_BASE) return null;
try { return (await apiFetch("/api/push/vapid-public-key")).key; } catch { return null; }
},
async subscribePush(subscription) {
if (!API_BASE) return;
return apiFetch("/api/push/subscribe", { method: "POST", body: JSON.stringify(subscription) });
},
async unsubscribePush(endpoint) {
if (!API_BASE) return;
return apiFetch("/api/push/subscribe", { method: "DELETE", body: JSON.stringify({ endpoint }) });
},

// ── Referrals ─────────────────────────────────────────────────────────────────────────
async getMyReferralCode() {
if (!API_BASE) return { code: "DEMO01", paid: 2, pending: 1, earned_tzs: 10000 };
return apiFetch("/api/referrals/my-code");
},
async useReferralCode(code) {
if (!API_BASE) return { ok: true };
return apiFetch("/api/referrals/use", { method: "POST", body: JSON.stringify({ code }) });
},

// ── Saved addresses ───────────────────────────────────────────────────────────────────
async getSavedAddresses() {
if (!API_BASE) {
  try { return JSON.parse(localStorage.getItem("asf_saved_addresses") || "[]"); } catch { return []; }
}
return apiFetch("/api/addresses");
},
async saveAddress(addr) {
if (!API_BASE) {
  try {
    const list = JSON.parse(localStorage.getItem("asf_saved_addresses") || "[]");
    const entry = { ...addr, id: secureId(), createdAt: new Date().toISOString() };
    list.push(entry);
    localStorage.setItem("asf_saved_addresses", JSON.stringify(list.slice(-3)));
    return entry;
  } catch { return addr; }
}
return apiFetch("/api/addresses", { method: "POST", body: JSON.stringify(addr) });
},
async deleteAddress(id) {
if (!API_BASE) {
  try {
    const list = JSON.parse(localStorage.getItem("asf_saved_addresses") || "[]");
    localStorage.setItem("asf_saved_addresses", JSON.stringify(list.filter(a => a.id !== id)));
  } catch {}
  return;
}
return apiFetch(`/api/addresses/${id}`, { method: "DELETE" });
},
async setDefaultAddress(id) {
if (!API_BASE) {
  try {
    const list = JSON.parse(localStorage.getItem("asf_saved_addresses") || "[]");
    localStorage.setItem("asf_saved_addresses", JSON.stringify(
      list.map(a => ({ ...a, isDefault: a.id === id }))
    ));
  } catch {}
  return;
}
return apiFetch(`/api/addresses/${id}/default`, { method: "PATCH", body: JSON.stringify({}) });
},
};

// ─── useApi hook — consistent loading / error / data state for any apiService call ─
//
// Usage:
//   const { data: products, loading, error, refetch } = useApi(
//     () => apiService.getProducts(country), [country]
//   );
//
function useApi(fetcher, deps = []) {
const [data,    setData]    = useState(null);
const [loading, setLoading] = useState(true);
const [error,   setError]   = useState(null);

const run = useCallback(async () => {
setLoading(true);
setError(null);
try {
const result = await fetcher();
setData(result);
} catch (err) {
setError(err.message || "Unknown error");
} finally {
setLoading(false);
}
// eslint-disable-next-line react-hooks/exhaustive-deps
}, deps);

useEffect(() => { run(); }, [run]);

return { data, loading, error, refetch: run };
}

// ─── Stock / Inventory utilities ────────────────────────────────────────────────────
//
// In production, stock levels come from the backend and are updated in real-time
// via the SSE stream (type: "stock_update", payload: { id, stockQty, reserved }).
//
// Client-side reservation pattern (prevents overselling):
//   addToCart   → reserve qty  (stockQty - 1 in local stock map)
//   removeCart  → release qty  (stockQty + 1)
//   checkout    → sold: backend decrements permanent stock
//
// Stock thresholds:
//   0         → Sold Out — Add to Cart disabled
//   1--5       → Low Stock — amber warning shown
//   6+        → In Stock (no badge)
//
const STOCK_LOW_THRESHOLD = 5;

function getStockStatus(qty) {
if (qty <= 0) return "out";
if (qty <= STOCK_LOW_THRESHOLD) return "low";
return "ok";
}

const StockBadge = React.memo(function StockBadge({ qty }) {
const status = getStockStatus(qty);
if (status === "ok") return null; // no badge for healthy stock
if (status === "out") return <span className="stock-badge stock-out">Sold Out</span>;
return <span className="stock-badge stock-low">Only {qty} left</span>;
});
StockBadge.displayName = "StockBadge";

// ─── useStock hook ────────────────────────────────────────────────────────────────────
// Manages a client-side stock map that starts from PRODUCTS.stockQty and applies
// reservations as items are added / removed from the cart.
//
// Returns:
//   stockMap   — { [productId]: currentQty }  (after reservations)
//   reserveQty(id)  — decrements by 1 (called on addToCart)
//   releaseQty(id)  — increments by 1 (called on removeFromCart)
//   syncStock(updates) — merges live SSE stock_update events
//
function useStock(products) {
const [stockMap, setStockMap] = useState(() => {
const m = {};
(products || []).forEach(p => { m[p.id] = p.stockQty ?? 999; });
return m;
});

// Re-initialise when products list changes (e.g. country switch loads new products)
useEffect(() => {
setStockMap(prev => {
const m = { ...prev };
(products || []).forEach(p => {
if (m[p.id] == null) m[p.id] = p.stockQty ?? 999;
});
return m;
});
}, [products]);

const reserveQty = useCallback(id => {
setStockMap(m => ({ ...m, [id]: Math.max(0, (m[id] ?? 0) - 1) }));
}, []);

const releaseQty = useCallback(id => {
setStockMap(m => ({ ...m, [id]: (m[id] ?? 0) + 1 }));
}, []);

// Called by SSE onStockUpdate handler
const syncStock = useCallback(updates => {
setStockMap(m => ({ ...m, ...updates }));
}, []);

return { stockMap, reserveQty, releaseQty, syncStock };
}

// ─── useFXRates hook — refreshes live FX rates every 6 hours ────────────────────────
//
// Production flow:
//   1. Your backend calls Open Exchange Rates (or CBK API) every 6 hours
//   2. Caches the result in Redis with a 6h TTL
//   3. Serves it at GET /api/fx  →  { base:"TZS", rates:{ KES:0.0465, USD:0.000358, ... } }
//
// Demo mode (API_BASE empty): returns SEED_FX immediately — no network call.
//
// The hook mutates the module-level FX object and forces a React re-render by
// bumping a counter state, so all fmt() calls across the app pick up fresh rates
// without any prop drilling.
//
function useFXRates() {
const [fxRevision, setFxRevision] = useState(0); // bumped on each successful refresh
const [fxMeta,     setFxMeta]     = useState({ source:"seed", updatedAt: null });

useEffect(() => {
let timer;

async function refresh() {
  if (!API_BASE) {
    // Demo mode — seed rates are already in FX, nothing to do
    setFxMeta({ source:"seed", updatedAt: new Date().toISOString() });
    return;
  }
  try {
    const res = await apiFetch("/api/fx");
    if (res?.rates && typeof res.rates === "object") {
      // Merge live rates into the module-level FX object
      Object.assign(FX, res.rates);
      setFxRevision(v => v + 1);
      setFxMeta({ source:"live", updatedAt: res.updatedAt || new Date().toISOString() });
    }
  } catch (err) {
    log.warn("[useFXRates] Using seed rates:", err.message);
  }
}

refresh(); // immediate on mount
timer = setInterval(refresh, FX_REFRESH_INTERVAL_MS); // every 6 hours
return () => clearInterval(timer);

}, []);

return { fxRevision, fxMeta };
}

// ─── useSSE hook — real-time order/rider/shipment updates via Server-Sent Events ─────
//
// Usage:
//   const { connected } = useSSE(country, {
//     onOrderUpdate:    patch => updateOrder(patch.id, patch),
//     onRiderUpdate:    patch => updateRider(patch.id, patch),
//     onShipmentUpdate: patch => updateShip(patch.id, patch),
//   });
//
// • Subscribes on mount and whenever country changes
// • Cleans up (closes EventSource / clears demo timer) on unmount
// • Returns { connected } so the UI can show a "live" badge
//
function useSSE(country, handlers) {
const [connected, setConnected] = useState(false);
// Keep handlers in a ref so the effect never needs to re-run when they change
const handlersRef = useRef(handlers);
useEffect(() => { handlersRef.current = handlers; });

useEffect(() => {
const unsubscribe = apiService.subscribeEvents(country, {
onConnected:      ()      => setConnected(true),
onDisconnected:   ()      => setConnected(false),
onOrderUpdate:    payload => handlersRef.current.onOrderUpdate?.(payload),
onRiderUpdate:    payload => handlersRef.current.onRiderUpdate?.(payload),
onShipmentUpdate: payload => handlersRef.current.onShipmentUpdate?.(payload),
});
return unsubscribe;
}, [country]);

return { connected };
}

// ─── PWA — Manifest injection + Service Worker registration + Install prompt ─────────
//
// This hook handles all three PWA concerns in one place:
//   1. Injects a Web App Manifest as a <link> tag so the browser recognises the app
//   2. Registers a Service Worker for offline caching and background sync
//   3. Captures the beforeinstallprompt event so we can show a custom install banner
//
// ── Service Worker ──
// In a production build the SW lives at /public/sw.js (copy SW_CODE below).
// In the artifact sandbox registration is attempted at /sw.js — it will gracefully
// fail if not found, which is expected in the preview environment.
//
// SW caching strategy (Workbox-style, implemented without the library):
//   • CacheFirst   — static assets (JS, CSS, fonts, images)
//   • NetworkFirst — API calls (/api/*)
//   • StaleWhileRevalidate — product listings (/api/products)
//   • BackgroundSync — queues failed order POSTs for replay when online
//
// DEPLOY INSTRUCTIONS for the Tanzania pilot:
//   1. Copy SW_CODE below → save as public/sw.js in your build folder
//   2. Serve public/sw.js with Cache-Control: no-cache header
//   3. Add public/manifest.json (generated by this hook as a blob — copy and save)
//   4. Add icon-192.png and icon-512.png to public/

const SW_CODE = `
// Asiel Farm Shop — Service Worker v1
// Deploy this file at /sw.js (web root, same origin as the app)

const CACHE_NAME = 'asiel-farm-shop-v1';
const API_CACHE  = 'asiel-api-v1';
const STATIC_ASSETS = ['/', '/index.html', '/static/js/main.js', '/static/css/main.css'];

// ── Install: pre-cache app shell ──
self.addEventListener('install', event => {
event.waitUntil(
caches.open(CACHE_NAME)
.then(c => c.addAll(STATIC_ASSETS).catch(() => {})) // ignore missing assets in dev
.then(() => self.skipWaiting())
);
});

// ── Activate: clean up old caches ──
self.addEventListener('activate', event => {
event.waitUntil(
caches.keys().then(keys =>
Promise.all(keys.filter(k => k !== CACHE_NAME && k !== API_CACHE).map(k => caches.delete(k)))
).then(() => self.clients.claim())
);
});

// ── Fetch: route-based caching strategy ──
self.addEventListener('fetch', event => {
const { request } = event;
const url = new URL(request.url);

// Skip non-GET, chrome-extension, and cross-origin requests
if (request.method !== 'GET' || url.origin !== self.location.origin) return;

// API product listings — StaleWhileRevalidate (fast + fresh)
if (url.pathname.startsWith('/api/products')) {
event.respondWith(staleWhileRevalidate(request, API_CACHE));
return;
}

// All other API calls — NetworkFirst (always try fresh, fall back to cache)
if (url.pathname.startsWith('/api/')) {
event.respondWith(networkFirst(request, API_CACHE, 5000));
return;
}

// Static assets — CacheFirst (serve instantly from cache)
event.respondWith(cacheFirst(request, CACHE_NAME));
});

// ── Background Sync: replay queued order POSTs ──
self.addEventListener('sync', event => {
if (event.tag === 'order-queue') {
event.waitUntil(replayOrderQueue());
}
});

async function replayOrderQueue() {
const db = await openOrderQueue();
const tx = db.transaction('queue', 'readwrite');
const all = await tx.objectStore('queue').getAll();
for (const item of all) {
try {
await fetch(item.url, { method:'POST', headers:{'Content-Type':'application/json'}, body: item.body });
await tx.objectStore('queue').delete(item.id);
} catch {} // will retry on next sync
}
}

// ── Caching helpers ──
async function cacheFirst(req, cacheName) {
const cached = await caches.match(req);
if (cached) return cached;
try {
const fresh = await fetch(req);
if (fresh.ok) { const c = await caches.open(cacheName); c.put(req, fresh.clone()); }
return fresh;
} catch { return new Response('Offline', { status: 503 }); }
}

async function networkFirst(req, cacheName, timeoutMs) {
try {
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), timeoutMs);
const fresh = await fetch(req, { signal: controller.signal });
clearTimeout(timer);
if (fresh.ok) { const c = await caches.open(cacheName); c.put(req, fresh.clone()); }
return fresh;
} catch {
const cached = await caches.match(req);
return cached || new Response('{"error":"offline"}', { status:503, headers:{'Content-Type':'application/json'} });
}
}

async function staleWhileRevalidate(req, cacheName) {
const cached = await caches.match(req);
const fetchPromise = fetch(req).then(fresh => {
if (fresh.ok) caches.open(cacheName).then(c => c.put(req, fresh.clone()));
return fresh;
}).catch(() => {});
return cached || fetchPromise;
}

function openOrderQueue() {
return new Promise((res, rej) => {
const r = indexedDB.open('asiel-order-queue', 1);
r.onupgradeneeded = e => e.target.result.createObjectStore('queue', { keyPath:'id', autoIncrement:true });
r.onsuccess = e => res(e.target.result);
r.onerror   = e => rej(e);
});
}
`;

// ── Web App Manifest (injected as blob <link> into <head>) ──
const APP_MANIFEST = {
name:             "Asiel Farm Shop",
short_name:       "AsFarm",
description:      "Farm-to-Fork marketplace — Tanzania & Kenya",
start_url:        "/",
scope:            "/",
display:          "standalone",
orientation:      "portrait-primary",
background_color: "#1a3a2a",
theme_color:      "#2d6a4f",
lang:             "sw",           // Swahili — Tanzania pilot
categories:       ["food", "shopping"],
icons: [
{ src:"/icon-192.png", sizes:"192x192", type:"image/png", purpose:"any maskable" },
{ src:"/icon-512.png", sizes:"512x512", type:"image/png", purpose:"any maskable" },
],
shortcuts: [
{ name:"Browse Market",  short_name:"Market",   url:"/?tab=market",   icons:[{ src:"/icon-192.png", sizes:"192x192" }] },
{ name:"AgriPass",       short_name:"AgriPass", url:"/?tab=agripass", icons:[{ src:"/icon-192.png", sizes:"192x192" }] },
],
};

function usePWA() {
const [canInstall,    setCanInstall]    = useState(false);
const [swReady,       setSwReady]       = useState(false);
const [dismissed,     setDismissed]     = useState(false);
const deferredPrompt = useRef(null);
const isIOS         = /iP(hone|ad|od)/.test(navigator.userAgent);
const isStandalone  = window.matchMedia("(display-mode: standalone)").matches
                   || window.navigator.standalone === true;
const isIOSInstallable = isIOS && !isStandalone;

useEffect(() => {
// ── 1. Inject Web App Manifest ──
// ── Analytics init (Sentry + PostHog) ──
analytics.init();

// Manifest is served as /manifest.webmanifest (static file)

// ── theme-color meta ──
let meta = document.querySelector("meta[name='theme-color']");
if (!meta) { meta = document.createElement("meta"); meta.name = "theme-color"; document.head.appendChild(meta); }
meta.content = "#2d6a4f";

// ── apple-mobile-web-app meta tags ──
const appleTags = [
  ["apple-mobile-web-app-capable",        "yes"],
  ["apple-mobile-web-app-status-bar-style","black-translucent"],
  ["apple-mobile-web-app-title",          "AsFarm"],
];
appleTags.forEach(([name, content]) => {
  if (!document.querySelector(`meta[name='${name}']`)) {
    const m = document.createElement("meta");
    m.name = name; m.content = content;
    document.head.appendChild(m);
  }
});

// ── 2. Register Service Worker ──
let onVisChange;
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js", { scope: "/" })
    .then(reg => {
      setSwReady(true);
      onVisChange = () => { if (document.visibilityState === "visible") reg.update(); };
      document.addEventListener("visibilitychange", onVisChange);
    })
    .catch(() => {
      // Expected in the artifact preview environment — /sw.js is not deployed
      setSwReady(false);
    });
}

// ── 3. Capture install prompt ──
const onPrompt = e => { e.preventDefault(); deferredPrompt.current = e; setCanInstall(true); };
window.addEventListener("beforeinstallprompt", onPrompt);

// ── 4. Detect successful install ──
const onInstalled = () => { setCanInstall(false); deferredPrompt.current = null; };
window.addEventListener("appinstalled", onInstalled);

return () => {
  window.removeEventListener("beforeinstallprompt", onPrompt);
  window.removeEventListener("appinstalled", onInstalled);
  if (onVisChange) document.removeEventListener("visibilitychange", onVisChange);
};

}, []);

const promptInstall = async () => {
if (!deferredPrompt.current) return;
deferredPrompt.current.prompt();
const { outcome } = await deferredPrompt.current.userChoice;
if (outcome === "accepted") { setCanInstall(false); deferredPrompt.current = null; }
};

const dismiss = () => setDismissed(true);

return { canInstall: (canInstall || isIOSInstallable) && !dismissed, isIOS: isIOSInstallable, isStandalone, swReady, promptInstall, dismiss };
}

// ─── Analytics data ─────────────────────────────────────────────────────────────────
const ANALYTICS_DATA = {
week: {
daily: [
{ day:"Mon", orders:12, revenue:384000 }, { day:"Tue", orders:18, revenue:576000 },
{ day:"Wed", orders:9,  revenue:288000 }, { day:"Thu", orders:24, revenue:768000 },
{ day:"Fri", orders:31, revenue:992000 }, { day:"Sat", orders:27, revenue:864000 },
{ day:"Sun", orders:15, revenue:480000 },
],
totalRevenue: 4352000, totalOrders: 136, deltaRev:"↑ 18% vs last week", deltaOrd:"↑ 12% vs last week",
},
month: {
daily: [
{ day:"W1",  orders:87,  revenue:2784000 }, { day:"W2",  orders:102, revenue:3264000 },
{ day:"W3",  orders:94,  revenue:3008000 }, { day:"W4",  orders:118, revenue:3776000 },
],
totalRevenue: 12832000, totalOrders: 401, deltaRev:"↑ 23% vs last month", deltaOrd:"↑ 16% vs last month",
},
topProducts: [
{ name:"Hass Avocados",  revenue:1820000, orders:243, emoji:"🥑" },
{ name:"Red Onions",     revenue:1550000, orders:201, emoji:"🧅" },
{ name:"Roma Tomatoes",  revenue:1320000, orders:172, emoji:"🍅" },
{ name:"Sweet Potato",   revenue:980000,  orders:128, emoji:"🍠" },
{ name:"Sukuma Wiki",    revenue:760000,  orders:99,  emoji:"🥬" },
],
hubStats: [
{ hub:"Ubungo Hub (TZ)",    incoming:34, greenlit:28, rejected:6, transit:14 },
{ hub:"Westlands Hub (KE)", incoming:29, greenlit:23, rejected:6, transit:11 },
],
riderPerf: [
{ name:"Juma Mwangi",   delivered:47, avgTime:"22 min", rating:4.8 },
{ name:"Amina Saleh",   delivered:38, avgTime:"28 min", rating:4.6 },
{ name:"Fatuma Ali",    delivered:41, avgTime:"24 min", rating:4.7 },
{ name:"Peter Kariuki", delivered:29, avgTime:"31 min", rating:4.5 },
],
countrySplit: { TZ: 58, KE: 42 },
};

// ─── Discount / coupon engine ───────────────────────────────────────────────────────
const COUPONS_DB = {
"FRESH10":  { type:"percent",  value:10,    desc:"10% off your order",            minOrder:10000  },
"ASIEL20":  { type:"percent",  value:20,    desc:"20% off — loyalty reward",      minOrder:50000  },
"ORGANIC5K":{ type:"fixed",    value:5000,  desc:"TZS 5,000 off organic produce", minOrder:20000  },
"FIRSTBUY": { type:"percent",  value:15,    desc:"15% first-order discount",      minOrder:0      },
"HARVEST3K":{ type:"fixed",    value:3000,  desc:"TZS 3,000 harvest season deal", minOrder:15000  },
};
function applyCoupon(code, cartTZS) {
const coupon = COUPONS_DB[code?.toUpperCase()?.trim()];
if (!coupon) return { valid:false, error:"Invalid coupon code." };
if (cartTZS < coupon.minOrder) return { valid:false, error:`Minimum order TZS ${coupon.minOrder.toLocaleString()} required.` };
const discount = coupon.type === "percent" ? Math.round(cartTZS * coupon.value / 100) : coupon.value;
return { valid:true, discount, desc:coupon.desc, code:code.toUpperCase().trim() };
}

// ─── Loyalty points system ──────────────────────────────────────────────────────────
// 1 point per TZS 100 spent. 100 points = TZS 2,000 redemption.
// ─── Payout ledger mock data ─────────────────────────────────────────────────────────
// Simulates the farmer's payout history as it would come from the backend.
// Each entry represents one completed delivery payout.
const PAYOUT_LEDGER_INIT = [
{ id:"PAY-2601", orderId:"ORD-2603", product:"Roma Tomatoes 5 KG",
gross:168000, commissionAmt:50400, flatFee:1000, vatAmt:9072, netFarmer:116600,
status:"paid", paidAt:"2026-03-27 11:45", method:"tigopesa", country:"TZ" },
{ id:"PAY-2602", orderId:"ORD-2601", product:"Hass Avocados 3 KG",
gross:46500,  commissionAmt:13950, flatFee:1000, vatAmt:2511, netFarmer:31550,
status:"paid", paidAt:"2026-03-27 10:30", method:"tigopesa", country:"TZ" },
{ id:"PAY-2603", orderId:"ORD-2605", product:"Hass Avocados 2 KG + Roma Tomatoes 3 KG",
gross:127100, commissionAmt:38130, flatFee:1000, vatAmt:6863, netFarmer:87970,
status:"processing", paidAt:null, method:"tigopesa", country:"TZ" },
{ id:"PAY-2604", orderId:"ORD-2602", product:"Sweet Maize 1 Crate",
gross:55900,  commissionAmt:16770, flatFee:0,    vatAmt:0,    netFarmer:39130,
status:"paid", paidAt:"2026-03-26 14:20", method:"mpesa", country:"KE" },
{ id:"PAY-2605", orderId:"ORD-2606", product:"Sweet Maize 2 Crates + Sukuma Wiki 4 Bunches",
gross:176200, commissionAmt:52860, flatFee:0,    vatAmt:0,    netFarmer:123340,
status:"pending", paidAt:null, method:"mpesa", country:"KE" },
];

// ─── Review seed data ────────────────────────────────────────────────────────────────
const REVIEWS_INIT = [
{ id:"REV-001", orderId:"ORD-2604", farmerId:"peter_mwangi",  farmerName:"Peter Mwangi",
product:"Sweet Potato", rating:5, comment:"Very fresh and well-packaged. Arrived exactly as described!", country:"KE",
customer:"Daniel K.", createdAt:"2026-03-26 15:10" },
{ id:"REV-002", orderId:"ORD-2602", farmerId:"john_otieno",   farmerName:"John Otieno",
product:"Sweet Maize",  rating:4, comment:"Good quality maize, slightly uneven crate sizing but overall satisfied.", country:"KE",
customer:"Brian O.", createdAt:"2026-03-26 11:55" },
];

// ─── Named constants (no magic numbers) ────────────────────────────────────────────────
const LOYALTY_REDEEM_THRESHOLD  = 100;    // minimum pts needed to redeem
const LOYALTY_TZS_PER_100_PTS   = 2000;  // TZS value per 100 redeemed points
const LOYALTY_PTS_PER_TZS       = 100;   // spend TZS 100 → earn 1 pt
const DEFAULT_LOYALTY_PTS       = 240;   // new user starting balance
const TOAST_DISMISS_MS          = 2500;  // toast auto-dismiss delay
// Cryptographically secure random ID — replaces Math.random() for all
// security-sensitive identifiers (payment refs, fiscal numbers, submission IDs).
function secureId(prefix = "", bytes = 5) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  const hex = Array.from(buf, b => b.toString(16).padStart(2, "0")).join("").toUpperCase();
  return prefix ? `${prefix}-${hex}` : hex;
}

const UNDO_WINDOW_MS            = 4000;  // cart undo window in ms
const PAYMENT_DEMO_DELAY_MS     = 2400;  // simulated payment processing delay
const DEMO_EVENT_INTERVAL_MS    = 12000; // SSE demo event replay interval
const BACKEND_SYNC_DELAY_MS     = 3000;  // debounced backend sync delay
const FX_REFRESH_INTERVAL_MS    = 6 * 60 * 60 * 1000; // 6 hours

const LOYALTY_TIERS = [
{ name:"Seedling",   min:0,    max:499,  icon:"🌱", color:"#5c3d1e" },
{ name:"Sprout",     min:500,  max:1499, icon:"🌿", color:"#2d6a4f" },
{ name:"Harvest",    min:1500, max:3999, icon:"🌾", color:"#e9a319" },
{ name:"Gold Farmer",min:4000, max:Infinity, icon:"🏆", color:"#c1440e" },
];
function getLoyaltyTier(points) {
return LOYALTY_TIERS.find(t => points >= t.min && points <= t.max) || LOYALTY_TIERS[0];
}
function earnPoints(tzsSpent)  { return Math.floor(tzsSpent / LOYALTY_PTS_PER_TZS); }
function redeemValue(points)   { return Math.floor(points / LOYALTY_REDEEM_THRESHOLD) * LOYALTY_TZS_PER_100_PTS; }

// ─── Farmer onboarding data ───────────────────────────────────────────────────────────
const TZ_REGIONS = [
  "Arusha","Dar es Salaam","Dodoma","Geita","Iringa","Kagera","Katavi","Kigoma",
  "Kilimanjaro","Lindi","Manyara","Mara","Mbeya","Morogoro","Mtwara","Mwanza",
  "Njombe","Pemba North","Pemba South","Pwani","Rukwa","Ruvuma","Shinyanga",
  "Simiyu","Singida","Songwe","Tabora","Tanga","Zanzibar North","Zanzibar South","Zanzibar West",
];
const KE_COUNTIES = [
  "Baringo","Bomet","Bungoma","Busia","Elgeyo-Marakwet","Embu","Garissa","Homa Bay",
  "Isiolo","Kajiado","Kakamega","Kericho","Kiambu","Kilifi","Kirinyaga","Kisii","Kisumu",
  "Kitui","Kwale","Laikipia","Lamu","Machakos","Makueni","Mandera","Marsabit","Meru",
  "Migori","Mombasa","Murang'a","Nairobi","Nakuru","Nandi","Narok","Nyamira","Nyandarua",
  "Nyeri","Samburu","Siaya","Taita-Taveta","Tana River","Tharaka-Nithi","Trans-Nzoia",
  "Turkana","Uasin Gishu","Vihiga","Wajir","West Pokot",
];
const CROPS_LIST = [
  "Tomatoes","Maize","Rice","Cassava","Sweet Potatoes","Irish Potatoes","Onions",
  "Garlic","Carrots","Cabbage","Spinach","Kale / Sukuma Wiki","Avocado","Bananas",
  "Mango","Papaya","Watermelon","Pineapple","Passion Fruit","Oranges","Lemons",
  "Coconut","Coffee","Tea","Sisal","Cotton","Sunflower","Sesame","Groundnuts",
  "Beans","Cowpeas","Chickpeas","Soybeans","Sorghum","Millet","Wheat",
  "Macadamia","Cashew","Pepper","Aubergine / Brinjal",
];
const FARM_SIZES = [
  { id:"small",  label:"Small",  labelSw:"Ndogo",   sub:"< 2 acres" },
  { id:"medium", label:"Medium", labelSw:"Wastani", sub:"2 – 10 acres" },
  { id:"large",  label:"Large",  labelSw:"Kubwa",   sub:"> 10 acres" },
];
const OB_PAYOUT_METHODS = [
  { id:"mpesa",  label:"M-Pesa",        icon:"🟢", countries:["TZ","KE"] },
  { id:"tigo",   label:"Tigo Pesa",     icon:"🔵", countries:["TZ"] },
  { id:"airtel", label:"Airtel Money",  icon:"🔴", countries:["TZ","KE"] },
  { id:"bank",   label:"Bank Transfer", icon:"🏦", countries:["TZ","KE"] },
];
const OB_TOTAL_STEPS = 7; // steps 1-7 (step 0 = welcome)

// ─── Commission / Escrow / Payout utilities ──────────────────────────────────────────
//
// calcCommission(orderTZS, country)
//   Returns a full breakdown of what happens to each shilling:
//   { gross, commissionAmt, flatFee, vat, netFarmer, escrowHold, label }
//
// All amounts are in TZS (integers — never use floats for money).
//
function calcCommission(orderTZS, country) {
const cfg    = getCfg(country);
const { pct, flatFee } = cfg.commission;
const gross        = Math.round(orderTZS);
const commissionAmt = Math.round(gross * pct / 100);
const vatAmt       = cfg.vfdRequired ? Math.round(commissionAmt * 0.18) : 0; // 18% VAT on commission (TZ)
const netFarmer    = gross - commissionAmt - flatFee;
return {
gross,
commissionAmt,
flatFee,
vatAmt,
netFarmer: Math.max(0, netFarmer),
escrowHold: gross,          // full amount held until delivery confirmed
pct,
label: cfg.commission.label,
payoutMethod: cfg.payments[0], // first payment method = primary payout channel
};
}

// formatCommissionLabel(orderTZS, country, cur)
//   Human-readable breakdown string for UI display
function formatCommissionLabel(orderTZS, country, cur) {
const c = calcCommission(orderTZS, country);
return `${c.pct}% (${fmt(c.commissionAmt, cur)})${c.flatFee ? ` + ${fmt(c.flatFee, cur)} flat fee` : ""} = ${fmt(c.netFarmer, cur)} to farmer`;
}

// PAYOUT_STATUS mirrors DB enum
const PAYOUT_STATUS = {
pending:    { label:"Pending",    cls:"ps-pending", icon:"⏳" },
processing: { label:"Processing", cls:"ps-proc",    icon:"🔄" },
paid:       { label:"Paid",       cls:"ps-paid",    icon:"✅" },
failed:     { label:"Failed",     cls:"ps-fail",    icon:"❌" },
};
const HUB_COORDS = {
"Ubungo Hub":    { lat:-6.7924, lng:39.2083 },
"Westlands Hub": { lat:-1.2676, lng:36.8033 },
"Accra Hub":     { lat:5.6037,  lng:-0.1870  },
"Lagos Hub":     { lat:6.5244,  lng:3.3792   },
"Kigali Hub":    { lat:-1.9441, lng:30.0619  },
"Kampala Hub":   { lat:0.3476,  lng:32.5825  },
};

// ─── Country Registry ────────────────────────────────────────────────────────────────
// Single source of truth for every country-specific setting.
// Adding a new country = adding one entry here. No other file changes needed.
//
// Shape of each entry:
//   name, flag, currency, dialPrefix, defaultCur
//   hub         — { name, coords }
//   payments    — ordered list of payment method IDs
//   vfdRequired — whether TRA/equivalent fiscal device is legally required
//   taxBody     — tax authority name
//   regulator   — comms regulator
//   certBody    — produce certification authority
//   commission  — { pct: number, flatFee: TZS-equivalent, label: string }
//   deliveryFee — in TZS (displayed as local currency via fmt())
//   city        — main pilot city
//   languages   — ISO codes in priority order
//   active      — false = coming soon (shown greyed in country picker)
const COUNTRY_REGISTRY = {
TZ: {
name: "Tanzania",       flag: "🇹🇿", currency: "TZS", dialPrefix: "+255", defaultCur: "TZS",
hub:         { name: "Ubungo Hub",    coords: { lat:-6.7924, lng:39.2083 } },
payments:    ["tigopesa","selcom","airtel","mpesa","card","bank"],
vfdRequired: true,
taxBody:     "TRA",   regulator: "TCRA",
certBody:    "TBS / TMDA / TOAM",
commission:  { pct: 30, flatFee: 1000, label: "30% + TZS 1,000 Market Entry Fee (TRA)" },
deliveryFee: 3500,
city:        "Dar es Salaam",
languages:   ["sw","en"],
active:      true,
},
KE: {
name: "Kenya",          flag: "🇰🇪", currency: "KES", dialPrefix: "+254", defaultCur: "KES",
hub:         { name: "Westlands Hub", coords: { lat:-1.2676, lng:36.8033 } },
payments:    ["mpesa","airtel","tigopesa","card","bank"],
vfdRequired: false,
taxBody:     "KRA",   regulator: "CA",
certBody:    "KEPHIS / KOAN",
commission:  { pct: 30, flatFee: 0,    label: "30% · Farmer paid within 2 hrs" },
deliveryFee: 3220,    // ≈ KES 150 in TZS
city:        "Nairobi",
languages:   ["sw","en"],
active:      true,
},
UG: {
name: "Uganda",         flag: "🇺🇬", currency: "UGX", dialPrefix: "+256", defaultCur: "UGX",
hub:         { name: "Kampala Hub",   coords: { lat:0.3476, lng:32.5825 } },
payments:    ["mtn_momo","airtel","card","bank"],
vfdRequired: false,
taxBody:     "URA",   regulator: "UCC",
certBody:    "UNBS",
commission:  { pct: 30, flatFee: 0,   label: "30% · MTN MoMo payout" },
deliveryFee: 3800,
city:        "Kampala",
languages:   ["sw","en"],
active:      false, // coming soon
},
RW: {
name: "Rwanda",         flag: "🇷🇼", currency: "RWF", dialPrefix: "+250", defaultCur: "RWF",
hub:         { name: "Kigali Hub",    coords: { lat:-1.9441, lng:30.0619 } },
payments:    ["mtn_momo","airtel","card","bank"],
vfdRequired: false,
taxBody:     "RRA",   regulator: "RURA",
certBody:    "RAB",
commission:  { pct: 30, flatFee: 0,   label: "30% · MoMo payout within 2 hrs" },
deliveryFee: 3200,
city:        "Kigali",
languages:   ["rw","fr","en"],
active:      false,
},
GH: {
name: "Ghana",          flag: "🇬🇭", currency: "GHS", dialPrefix: "+233", defaultCur: "GHS",
hub:         { name: "Accra Hub",     coords: { lat:5.6037, lng:-0.1870 } },
payments:    ["mtn_momo","airtel","card","bank"],
vfdRequired: false,
taxBody:     "GRA",   regulator: "NCA",
certBody:    "PPRSD / COCOBOD",
commission:  { pct: 30, flatFee: 0,   label: "30% · MoMo payout" },
deliveryFee: 3600,
city:        "Accra",
languages:   ["en","tw"],
active:      false,
},
NG: {
name: "Nigeria",        flag: "🇳🇬", currency: "NGN", dialPrefix: "+234", defaultCur: "NGN",
hub:         { name: "Lagos Hub",     coords: { lat:6.5244, lng:3.3792 } },
payments:    ["mtn_momo","opay","card","bank"],
vfdRequired: true,
taxBody:     "FIRS",  regulator: "NCC",
certBody:    "NAFDAC / SON",
commission:  { pct: 30, flatFee: 0,   label: "30% · MTN MoMo / OPay payout" },
deliveryFee: 4200,
city:        "Lagos",
languages:   ["en","ha","yo","ig"],
active:      false,
},
};

// Helper — returns the registry entry for the active country, falls back to TZ
function getCfg(country) {
return COUNTRY_REGISTRY[country] ?? COUNTRY_REGISTRY.TZ;
}
function calcDistKm(lat1, lng1, lat2, lng2) {
const R=6371, dLat=(lat2-lat1)*Math.PI/180, dLng=(lng2-lng1)*Math.PI/180;
const a=Math.sin(dLat/2)**2+Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
return (R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a))).toFixed(1);
}

const AP_CRITERIA = ["Appearance","Freshness","Size Uniformity","Cleanliness","Pest/Disease","Packaging"];
const AP_GRADES   = ["A","B","C","F"];
const GRADE_COLOR = { A:"#155724", B:"#0c5460", C:"#856404", F:"#842029" };
const GRADE_BG    = { A:"#d4edda", B:"#d1ecf1", C:"#fff3cd", F:"#f8d7da" };

const AP_SUBMISSIONS_INIT = [
{
id:"AP-2601", produce:"Hass Avocados", submitter:"Mama Zawadi", role:"Farmer",
origin:"Kilifi County, Kenya", qty:"80 KG", harvestDate:"2026-03-25",
contact:"+254 712 001 000", notes:"Stored in cool shade, harvested at peak.",
country:"KE",
status:"approved", inspector:"Dr. Amani Mwita",
grades:{Appearance:"A",Freshness:"A","Size Uniformity":"B",Cleanliness:"A","Pest/Disease":"A",Packaging:"B"},
remarks:"Excellent quality, consistent size and colour. Minor variation in uniformity.",
certId:"CERT-KE-0041-2026", validUntil:"2026-04-08", rejectionInfo:null,
submittedAt:"2026-03-26 08:15"
},
{
id:"AP-2602", produce:"Roma Tomatoes", submitter:"Baba Juma", role:"Farmer",
origin:"Morogoro, Tanzania", qty:"120 KG", harvestDate:"2026-03-24",
contact:"+255 765 002 000", notes:"Harvested early morning, packed in ventilated crates.",
country:"TZ",
status:"rejected", inspector:"Dr. Amani Mwita",
grades:{Appearance:"C",Freshness:"B","Size Uniformity":"C",Cleanliness:"B","Pest/Disease":"F",Packaging:"C"},
remarks:"Significant pest damage found on 30% of batch. Fungal spotting visible on outer layer.",
certId:null, validUntil:null,
rejectionInfo:{
category:"Pest & Disease Contamination",
feedback:"A substantial portion of the batch shows clear evidence of fruit fly infestation and fungal spotting. The produce does not meet minimum safety standards for market entry. Please treat affected plants, wait at least 14 days before resubmission, and ensure proper post-harvest handling.",
canResubmit:true, resubmitAfter:"2026-04-10"
},
submittedAt:"2026-03-26 09:30"
},
{
id:"AP-2603", produce:"Sukuma Wiki", submitter:"Grace Ndungu", role:"Farmer",
origin:"Kiambu, Kenya", qty:"200 Bunches", harvestDate:"2026-03-27",
contact:"+254 722 003 000", notes:"Cut fresh this morning, washed and bundled.",
country:"KE",
status:"pending", inspector:null,
grades:{}, remarks:"", certId:null, validUntil:null, rejectionInfo:null,
submittedAt:"2026-03-27 06:45"
},
{
id:"AP-2604", produce:"Red Onions", submitter:"Kilimanjaro Fresh Ltd", role:"Shop Owner",
origin:"Arusha, Tanzania", qty:"300 KG", harvestDate:"2026-03-20",
contact:"+255 783 004 000", notes:"Sourced from TBS-certified farm. Properly cured.",
country:"TZ",
status:"approved", inspector:"Insp. Fatuma Rashidi",
grades:{Appearance:"A",Freshness:"A","Size Uniformity":"A",Cleanliness:"A","Pest/Disease":"A",Packaging:"A"},
remarks:"Outstanding batch. All criteria meet Grade A standards. Cleared for retail.",
certId:"CERT-TZ-0088-2026", validUntil:"2026-04-10", rejectionInfo:null,
submittedAt:"2026-03-25 14:00"
},
{
id:"AP-2605", produce:"Sweet Maize", submitter:"John Otieno", role:"Farmer",
origin:"Kisumu, Kenya", qty:"50 Crates", harvestDate:"2026-03-26",
contact:"+254 733 005 000", notes:"Crates lined with dry banana leaves for cushioning.",
country:"KE",
status:"pending", inspector:null,
grades:{}, remarks:"", certId:null, validUntil:null, rejectionInfo:null,
submittedAt:"2026-03-27 07:20"
},
];

// ─── Safe QR SVG component ──────────────────────────────────────────────────────────
function sanitiseQRInput(raw) {
// Strip all non-alphanumeric / safe chars — input only used as hash seed, never rendered as HTML
return String(raw ?? "").replace(/[^a-zA-Z0-9-_.]/g, "").slice(0, 64);
}
function makeQRHash(data) {
let hash = 0;
const s = sanitiseQRInput(data);
for (let i = 0; i < s.length; i++) { hash = ((hash << 5) - hash) + s.charCodeAt(i); hash |= 0; }
return hash;
}
function QRCode({ data, size = 84 }) {
const hash = makeQRHash(data);
const gridSize = 21;
const cell = size / gridSize;
const rects = [];
for (let r = 0; r < gridSize; r++) {
for (let c = 0; c < gridSize; c++) {
const inFinder   = (r<7&&c<7)||(r<7&&c>13)||(r>13&&c<7);
const onBorder   = ((r===0||r===6||c===0||c===6)&&r<7&&c<7)||((r===0||r===6||c===14||c===20)&&r<7&&c>13)||((r===14||r===20||c===0||c===6)&&r>13&&c<7);
const innerFinder= (r>=2&&r<=4&&c>=2&&c<=4)||(r>=2&&r<=4&&c>=16&&c<=18)||(r>=16&&r<=18&&c>=2&&c<=4);
let on = false;
if (inFinder) on = onBorder || innerFinder;
else { const bit = (hash ^ (r*gridSize+c)*0x9e3779b9) & 1; on = !!bit; }
if (on) rects.push(<rect key={`${r}-${c}`} x={c*cell} y={r*cell} width={cell} height={cell} fill="#1a3a2a"/>);
}
}
return (
<svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{display:"block",borderRadius:4}}>
<rect width={size} height={size} fill="white"/>
{rects}
</svg>
);
}

// ─── CSS ────────────────────────────────────────────────────────────────────────────
// Font strategy: load Google Fonts with font-display:swap so the UI renders
// immediately using system fonts, then swaps in Playfair/DM Sans when the CDN
// responds. Offline users get a perfectly readable system-font UI.
const fonts = `@import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700;900&family=DM+Sans:wght@300;400;500;600&display=swap');`;

const css = `
${fonts}
*, *::before, *::after { box-sizing:border-box; margin:0; padding:0; }
html { height:100%; -webkit-text-size-adjust:100%; text-size-adjust:100%; }
body { touch-action:pan-y; overscroll-behavior:none; -webkit-font-smoothing:antialiased; }
:root {
--forest:#1a3a2a; --leaf:#2d6a4f; --mint:#52b788; --gold:#e9a319; --amber:#f4c430;
--terra:#c1440e; --sand:#f0e6c8; --bark:#5c3d1e; --charcoal:#1e1e1e; --mist:#f7f3ec;
--shadow-sm:0 2px 8px rgba(26,58,42,.10); --shadow-md:0 6px 24px rgba(26,58,42,.15);
--shadow-lg:0 16px 48px rgba(26,58,42,.22); --radius:16px;
--gold-text:#7a4600;  /* 7.2:1 on white — WCAG AAA — use for amber text on light bg */
--amber-text:#6b4e00; /* 8.1:1 on white — WCAG AAA — use for gold text on light bg */
--font-head:'Playfair Display',Georgia,'Times New Roman',serif;
--font-body:'DM Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
--spring:cubic-bezier(.34,1.56,.64,1);
}
[data-theme="dark"] {
  --forest:#0d1f16; --leaf:#1a4030; --mint:#52b788; --gold:#e9a319; --amber:#f4c430;
  --terra:#c1440e; --sand:#1e2832; --bark:#8a6545; --charcoal:#e0e0e0; --mist:#1a2030;
  --shadow-sm:0 2px 8px rgba(0,0,0,.35); --shadow-md:0 6px 24px rgba(0,0,0,.45);
  --shadow-lg:0 16px 48px rgba(0,0,0,.55);
}
body[data-theme="dark"] { background:#111820; color:#dce0e8; }

body { font-family:var(--font-body); background:var(--mist); color:var(--charcoal);
  -webkit-tap-highlight-color:transparent; -webkit-font-smoothing:antialiased;
  overscroll-behavior:none; }
button, [role="button"], a { touch-action:manipulation; cursor:pointer; }
button:focus-visible, [role="button"]:focus-visible, a:focus-visible {
  outline:3px solid var(--mint); outline-offset:2px; }
/* iOS auto-zoom prevention: inputs must be ≥16px */
input, select, textarea {
  font-size:max(16px, 1rem);
  -webkit-appearance:none; appearance:none;
}
input[type="checkbox"], input[type="radio"] {
  -webkit-appearance:auto; appearance:auto; font-size:inherit;
  width:18px; height:18px; cursor:pointer;
}

/* ── APP LAYOUT ── */
.app { min-height:100dvh; height:100dvh; display:flex; flex-direction:column;
  padding-bottom:calc(68px + env(safe-area-inset-bottom,0px));
  overflow-y:auto; -webkit-overflow-scrolling:touch; overscroll-behavior-y:none; }

/* ── BOTTOM NAV ── */
.bottom-nav {
position:fixed; bottom:0; left:0; right:0; z-index:200;
background:white; border-top:1px solid var(--sand);
display:flex; height:calc(64px + env(safe-area-inset-bottom,0px));
box-shadow:0 -4px 20px rgba(26,58,42,.10);
padding-bottom:env(safe-area-inset-bottom,0px);
padding-left:env(safe-area-inset-left,0px);
padding-right:env(safe-area-inset-right,0px);
}
.bn-item {
flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center;
gap:3px; cursor:pointer; border:none; background:transparent;
font-family:var(--font-body); transition:all .18s; position:relative; padding:0 4px;
 touch-action:manipulation; -webkit-tap-highlight-color:transparent; }
.bn-icon  { font-size:20px; transition:transform .22s var(--spring); display:block; }
.bn-label { font-size:10px; font-weight:600; color:#bbb; transition:color .18s; white-space:nowrap; }
.bn-item.active .bn-label { color:var(--forest); font-weight:700; }
.bn-item.active .bn-icon  { transform:scale(1.2) translateY(-2px); }
.bn-item::before {
content:''; position:absolute; top:0; left:50%; transform:translateX(-50%);
width:0; height:3px; background:var(--mint); border-radius:0 0 3px 3px; transition:width .22s var(--spring);
}
.bn-item.active::before { width:40px; }
.bn-badge {
position:absolute; top:10px; right:calc(50% - 18px);
background:var(--terra); color:white; border-radius:50%;
width:16px; height:16px; font-size:9px; font-weight:700;
display:flex; align-items:center; justify-content:center;
}

/* ── SHIMMER SKELETON ── */
@keyframes shimmer { 0%{background-position:-400px 0} 100%{background-position:400px 0} }
.shimmer { background:linear-gradient(90deg,#f0ebe0 25%,#fdf6e3 50%,#f0ebe0 75%); background-size:800px 100%; animation:shimmer 1.4s ease-in-out infinite; border-radius:10px; }
.shimmer-card { background:white; border-radius:var(--radius); overflow:hidden; box-shadow:var(--shadow-sm); }
.shimmer-img  { height:126px; }
.shimmer-line { height:12px; margin:10px 12px 6px; }
.shimmer-line.short { width:60%; }

/* ── SCROLL TO TOP ── */
.scroll-top {
position:fixed; bottom:82px; right:16px; z-index:190;
width:40px; height:40px; border-radius:50%; border:none;
background:var(--forest); color:white; font-size:16px;
display:flex; align-items:center; justify-content:center;
cursor:pointer; box-shadow:var(--shadow-md); animation:popIn .25s var(--spring);
}
@keyframes popIn { from{opacity:0;transform:scale(.6)} to{opacity:1;transform:scale(1)} }
.scroll-top:hover { background:var(--leaf); }

/* ── QTY CONTROLS ── */
.ci-qty-row { display:flex; align-items:center; gap:8px; margin-top:6px; }
.qty-btn { width:26px; height:26px; border-radius:8px; border:1.5px solid var(--sand); background:white; font-size:14px; font-weight:700; cursor:pointer; display:flex; align-items:center; justify-content:center; color:var(--forest); transition:all .15s; flex-shrink:0; }
.qty-btn:hover { background:var(--forest); color:white; border-color:var(--forest); }
.qty-val { font-size:13px; font-weight:700; color:var(--charcoal); min-width:18px; text-align:center; }
.ci-remove { background:none; border:none; color:#ddd; cursor:pointer; font-size:16px; margin-left:auto; padding:4px; transition:color .15s; }
.ci-remove:hover { color:var(--terra); }

/* ── EMPTY STATE ── */
.empty-state { text-align:center; padding:48px 20px; color:#ccc; }
.empty-state .es-icon { font-size:52px; }
.empty-state h3 { font-family:var(--font-head); font-size:20px; color:var(--bark); margin-top:14px; }
.empty-state p { font-size:13px; margin-top:6px; line-height:1.6; max-width:240px; margin-left:auto; margin-right:auto; }
.empty-state button { margin-top:16px; padding:10px 22px; background:var(--forest); color:white; border:none; border-radius:12px; font-size:13px; font-weight:600; cursor:pointer; font-family:var(--font-body); transition:background .18s; }
.empty-state button:hover { background:var(--leaf); }

/* ── ONBOARDING TIP ── */
.tip-banner { margin:10px 18px 0; background:rgba(82,183,136,.1); border:1px solid rgba(82,183,136,.3); border-radius:12px; padding:10px 14px; display:flex; align-items:center; gap:10px; font-size:12px; color:var(--forest); animation:slideDown .3s var(--spring); }
.tip-icon  { font-size:20px; flex-shrink:0; }
.tip-close { margin-left:auto; background:none; border:none; color:#aaa; cursor:pointer; font-size:14px; line-height:1; }

/* ── SEARCH ── */
.search-wrap { position:relative; flex:1; }
.search-wrap input { width:100%; border:none; outline:none; font-size:14px; font-family:var(--font-body); background:transparent; }
.search-clear { position:absolute; right:4px; top:50%; transform:translateY(-50%); background:#e8e4dc; border:none; border-radius:50%; width:20px; height:20px; font-size:11px; cursor:pointer; display:flex; align-items:center; justify-content:center; color:#888; }

/* ── NAV ── */
.nav {
background:var(--forest); display:flex; align-items:center; justify-content:space-between;
padding:env(safe-area-inset-top,0px) 16px 0; height:calc(60px + env(safe-area-inset-top,0px));
position:sticky; top:0; z-index:100;
box-shadow:0 2px 12px rgba(0,0,0,.28); gap:10px;
}
.nav-logo { font-family:var(--font-head); color:var(--amber); font-size:17px; letter-spacing:-.5px; white-space:nowrap; flex-shrink:0; line-height:1.1; display:flex; align-items:center; }
.nav-logo span { color:var(--mint); }
.nav-right { display:flex; align-items:center; gap:7px; }
.country-toggle { display:flex; background:rgba(255,255,255,.1); border-radius:20px; border:1px solid rgba(255,255,255,.15); overflow:hidden; }
.country-opt { padding:4px 9px; font-size:11px; font-weight:600; cursor:pointer; color:rgba(255,255,255,.5); border:none; background:transparent; font-family:var(--font-body); transition:all .18s; }
.country-opt.active { background:var(--mint); color:var(--forest); border-radius:20px; }
.country-opt.coming-soon { opacity:.35; cursor:not-allowed; font-style:italic; }
.cart-btn { position:relative; background:var(--gold); border:none; border-radius:50%; width:35px; height:35px; display:flex; align-items:center; justify-content:center; cursor:pointer; font-size:15px; transition:transform .2s var(--spring); flex-shrink:0; }
.cart-btn:hover { transform:scale(1.12); }
.cart-badge { position:absolute; top:-4px; right:-4px; background:var(--terra); color:white; border-radius:50%; width:16px; height:16px; font-size:9px; font-weight:700; display:flex; align-items:center; justify-content:center; }

/* ── CURRENCY PICKER ── */
.cur-picker { position:relative; }
.cur-btn { display:flex; align-items:center; gap:5px; background:rgba(255,255,255,.12); border-radius:20px; padding:5px 10px; font-size:11px; color:var(--amber); border:1px solid rgba(255,255,255,.16); cursor:pointer; font-family:var(--font-body); font-weight:700; transition:background .18s; white-space:nowrap; }
.cur-btn:hover { background:rgba(255,255,255,.22); }
.cur-caret { font-size:9px; opacity:.65; }
.cur-drop { position:absolute; top:calc(100% + 8px); right:0; background:white; border-radius:16px; padding:8px; box-shadow:var(--shadow-lg); min-width:218px; z-index:400; animation:dropIn .22s var(--spring); }
@keyframes dropIn { from{opacity:0;transform:translateY(-8px)} to{opacity:1;transform:translateY(0)} }
.cur-drop-title { font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:1px; color:#bbb; padding:4px 8px 8px; border-bottom:1px solid var(--sand); margin-bottom:5px; }
.cur-opt { display:flex; align-items:center; gap:9px; padding:8px 10px; border-radius:10px; cursor:pointer; transition:background .14s; }
.cur-opt:hover { background:var(--mist); }
.cur-opt.sel { background:var(--forest); }
.cur-opt.sel .cur-code, .cur-opt.sel .cur-label { color:white; }
.cur-flag { font-size:18px; flex-shrink:0; }
.cur-code { font-weight:700; font-size:13px; color:var(--forest); width:34px; }
.cur-label { font-size:12px; color:#999; flex:1; }
.cur-sym { font-size:14px; font-weight:700; color:var(--gold); }
.cur-opt.sel .cur-sym { color:var(--amber); }
.cur-base-tag { font-size:9px; background:var(--amber); color:var(--forest); border-radius:8px; padding:1px 5px; font-weight:700; margin-left:2px; }

/* ── FX TICKER ── */
.fx-bar { background:linear-gradient(90deg,#122b1e,#1a3a2a); padding:5px 18px; display:flex; gap:18px; overflow-x:auto; align-items:center; border-bottom:1px solid rgba(255,255,255,.06); }
.fx-bar::-webkit-scrollbar { display:none; }
.fx-lbl { font-size:10px; color:rgba(255,255,255,.3); white-space:nowrap; flex-shrink:0; }
.fx-tag { font-size:11px; color:rgba(255,255,255,.55); white-space:nowrap; flex-shrink:0; }
.fx-tag strong { color:var(--amber); }

/* ── HERO ── */
.hero { background:linear-gradient(135deg,var(--forest) 0%,var(--leaf) 58%,#3d8b65 100%); padding:28px 22px 20px; position:relative; overflow:hidden; }
.hero::before { content:''; position:absolute; right:-40px; top:-40px; width:200px; height:200px; border-radius:50%; background:radial-gradient(circle,rgba(233,163,25,.18) 0%,transparent 70%); }
.hero::after { content:'🌾'; position:absolute; right:22px; bottom:-8px; font-size:80px; opacity:.16; }
.hero-tag { display:inline-block; background:var(--gold); color:var(--forest); border-radius:20px; padding:3px 11px; font-size:10px; font-weight:700; letter-spacing:.5px; text-transform:uppercase; margin-bottom:9px; }
.hero h1 { font-family:var(--font-head); color:white; font-size:23px; line-height:1.22; }
.hero h1 em { color:var(--amber); font-style:normal; }
.hero p { color:rgba(255,255,255,.72); font-size:13px; margin-top:6px; }
.hero-cur-badge { display:inline-flex; align-items:center; gap:4px; background:rgba(255,255,255,.15); border-radius:20px; padding:2px 10px; font-size:11px; color:var(--amber); font-weight:600; margin-top:5px; }
.hero-search { margin-top:14px; display:flex; gap:7px; background:white; border-radius:12px; padding:5px 5px 5px 14px; box-shadow:var(--shadow-md); }
.hero-search button { background:var(--gold); border:none; border-radius:8px; padding:7px 13px; font-size:13px; font-weight:600; cursor:pointer; color:var(--forest); }

/* ── FILTERS ── */
.filter-row { padding:11px 18px; display:flex; gap:7px; overflow-x:auto; background:white; border-bottom:1px solid var(--sand); }
.filter-row::-webkit-scrollbar { display:none; }
.chip { flex-shrink:0; padding:5px 12px; border-radius:20px; font-size:12px; font-weight:500; cursor:pointer; border:1.5px solid var(--sand); background:white; color:var(--bark); transition:all .17s; white-space:nowrap; }
.chip.active { background:var(--forest); color:white; border-color:var(--forest); }
.chip:hover:not(.active) { border-color:var(--mint); color:var(--leaf); }

/* ── SECTION LABEL ── */
.sec-label { padding:16px 22px 9px; font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:1px; color:var(--bark); display:flex; align-items:center; gap:8px; }
.sec-label::after { content:''; flex:1; height:1px; background:var(--sand); }

/* ── PRODUCT GRID / CARD ── */
.grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(165px,1fr)); gap:13px; padding:0 18px 24px; }
.card { background:white; border-radius:var(--radius); overflow:hidden; box-shadow:var(--shadow-sm); cursor:pointer; position:relative; transition:transform .22s var(--spring),box-shadow .22s;  touch-action:manipulation; -webkit-tap-highlight-color:transparent; }
.card:hover { transform:translateY(-4px); box-shadow:var(--shadow-md); }
.card-img { width:100%; height:126px; background:linear-gradient(135deg,var(--sand),var(--mist)); display:flex; align-items:center; justify-content:center; font-size:50px; position:relative; }
.badge-org { position:absolute; top:8px; left:8px; background:var(--leaf); color:white; font-size:9px; font-weight:700; padding:2px 7px; border-radius:20px; }
.badge-ver { position:absolute; top:8px; right:8px; background:var(--gold); color:var(--forest); font-size:9px; font-weight:700; padding:2px 6px; border-radius:20px; }
.fav-btn { position:absolute; bottom:8px; right:8px; background:rgba(255,255,255,.85); border:none; border-radius:50%; width:28px; height:28px; font-size:14px; line-height:28px; text-align:center; cursor:pointer; padding:0; transition:transform .15s; box-shadow:0 1px 4px rgba(0,0,0,.2); }
.fav-btn:hover { transform:scale(1.18); }
.fav-btn.fav-active { background:rgba(255,255,255,.95); }
.card-body { padding:11px; }
.card-name { font-weight:600; font-size:14px; }
.card-farmer { font-size:11px; color:var(--leaf); margin-top:2px; }
.card-meta { display:flex; align-items:flex-start; justify-content:space-between; margin-top:8px; gap:4px; }
.card-price { font-family:var(--font-head); font-size:15px; color:var(--forest); }
.card-price span { font-size:10px; font-family:var(--font-body); color:#aaa; }
.card-tzs { font-size:10px; color:var(--leaf); margin-top:1px; }
.card-dist { font-size:10px; color:#bbb; white-space:nowrap; }
.card-add { margin-top:8px; width:100%; background:var(--forest); color:white; border:none; border-radius:8px; padding:7px; font-size:12px; font-weight:600; cursor:pointer; font-family:var(--font-body); transition:background .17s; }
.card-add:hover { background:var(--leaf); }
.card-add.in { background:var(--gold); color:var(--forest); }
.card-add:disabled { background:#ccc; color:#888; cursor:not-allowed; }
/* Stock badges */
.stock-badge     { display:inline-block; font-size:10px; font-weight:700; border-radius:6px; padding:2px 7px; margin-top:4px; }
.stock-low       { background:#fff3cd; color:#856404; }
.stock-out       { background:#f8d7da; color:#721c24; }
.stock-ok        { background:#d4edda; color:#155724; }

/* ── PRODUCT MODAL ── */
.modal-bd { position:fixed; inset:0; background:rgba(0,0,0,.55); z-index:200; display:flex; align-items:flex-end; justify-content:center; animation:fadeIn .2s; }
@keyframes fadeIn { from{opacity:0} to{opacity:1} }
.modal { background:white; border-radius:24px 24px 0 0; width:100%; max-width:540px; padding:0 0 32px; animation:slideUp .3s var(--spring); max-height:92vh; overflow-y:auto; }
@keyframes slideUp { from{transform:translateY(100%)} to{transform:translateY(0)} }
.modal-handle { width:38px; height:4px; background:#ddd; border-radius:2px; margin:12px auto 0; }
.modal-img { width:100%; height:185px; background:linear-gradient(135deg,var(--sand),var(--mist)); display:flex; align-items:center; justify-content:center; font-size:86px; position:relative; }
.modal-badges { position:absolute; top:12px; left:12px; display:flex; gap:5px; }
.modal-close { position:absolute; top:12px; right:12px; background:rgba(0,0,0,.28); border:none; color:white; border-radius:50%; width:30px; height:30px; font-size:16px; cursor:pointer; display:flex; align-items:center; justify-content:center; }
.modal-body { padding:17px 20px 0; }
.modal-title { font-family:var(--font-head); font-size:24px; color:var(--forest); }
.modal-main-price { font-family:var(--font-head); font-size:27px; color:var(--gold); margin-top:6px; }
.modal-unit { font-size:12px; color:#aaa; margin-top:2px; }
.conv-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:6px; margin-top:10px; }
.conv-pill { background:var(--mist); border-radius:10px; padding:7px 8px; display:flex; flex-direction:column; align-items:center; gap:2px; cursor:pointer; transition:background .15s; }
.conv-pill:hover { background:var(--sand); }
.conv-pill .cf { font-size:16px; }
.conv-pill .cc { font-size:10px; color:#aaa; }
.conv-pill .cv { font-size:13px; font-weight:700; color:var(--forest); }
.conv-pill.active-cur { background:var(--forest); }
.conv-pill.active-cur .cc,.conv-pill.active-cur .cv { color:white; }
.conv-pill.base-cur { border:1.5px solid var(--gold); }
.modal-weighted { background:var(--sand); border-radius:10px; padding:10px 13px; font-size:12px; color:var(--bark); margin-top:12px; line-height:1.6; border-left:3px solid var(--gold); }
.divider { height:1px; background:var(--sand); margin:15px 0; }
.farmer-card { display:flex; gap:12px; background:var(--mist); border-radius:14px; padding:13px; }
.farmer-av { width:50px; height:50px; border-radius:50%; flex-shrink:0; background:linear-gradient(135deg,var(--leaf),var(--mint)); display:flex; align-items:center; justify-content:center; font-size:22px; }
.farmer-name { font-weight:600; font-size:15px; color:var(--forest); }
.farmer-loc { font-size:12px; color:#aaa; margin-top:2px; }
.farmer-bio { font-size:12px; color:var(--charcoal); margin-top:6px; line-height:1.5; }
.farmer-stats { display:flex; gap:14px; margin-top:10px; }
.fs-val { font-weight:700; font-size:15px; color:var(--forest); }
.fs-lbl { font-size:10px; color:#aaa; text-transform:uppercase; letter-spacing:.4px; }
.qr-row { display:flex; align-items:center; gap:11px; background:white; border-radius:10px; padding:11px; border:1.5px solid var(--sand); margin-top:13px; }
.qr-box { width:48px; height:48px; background:var(--forest); border-radius:8px; display:flex; align-items:center; justify-content:center; color:white; font-size:22px; }
.qr-text { font-size:12px; color:var(--bark); line-height:1.6; }
.qr-text strong { color:var(--forest); }
.modal-add { margin:17px 20px 0; width:calc(100% - 40px); background:var(--forest); color:white; border:none; border-radius:14px; padding:14px; font-size:14px; font-weight:600; cursor:pointer; font-family:var(--font-body); transition:background .18s; }
.modal-add:hover { background:var(--leaf); }
.modal-add:disabled { background:#ccc; color:#888; cursor:not-allowed; }

/* ── FARMER PORTAL ── */
.portal { padding:20px; max-width:540px; margin:0 auto; }
.portal h2 { font-family:var(--font-head); font-size:23px; color:var(--forest); }
.portal .sub { font-size:13px; color:#888; margin-top:4px; margin-bottom:18px; }
.fcard { background:white; border-radius:var(--radius); padding:17px; box-shadow:var(--shadow-sm); margin-bottom:13px; }
.fcard h3 { font-size:13px; font-weight:600; color:var(--forest); margin-bottom:13px; }
.fg { display:flex; flex-direction:column; gap:5px; flex:1; margin-bottom:11px; }
.fg label { font-size:10px; font-weight:700; color:var(--bark); letter-spacing:.5px; text-transform:uppercase; }

/* ── Payout Ledger ── */
.payout-summary { display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-bottom:14px; }
.payout-kpi     { background:var(--mist); border-radius:12px; padding:10px 12px; }
.payout-kpi-val { font-family:var(--font-head); font-size:18px; color:var(--forest); }
.payout-kpi-lbl { font-size:10px; color:#888; text-transform:uppercase; letter-spacing:.5px; margin-top:2px; }
.payout-row     { display:flex; align-items:flex-start; gap:10px; padding:11px 0; border-bottom:1px solid var(--sand); }
.payout-row:last-child { border-bottom:none; }
.payout-icon    { font-size:20px; flex-shrink:0; margin-top:1px; }
.payout-detail  { flex:1; min-width:0; }
.payout-product { font-size:12px; font-weight:600; color:var(--charcoal); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.payout-meta    { font-size:10px; color:#aaa; margin-top:2px; }
.payout-amount  { text-align:right; flex-shrink:0; }
.payout-net     { font-family:var(--font-head); font-size:15px; color:var(--forest); }
.payout-gross   { font-size:10px; color:#bbb; margin-top:2px; }
.ps-badge       { display:inline-flex; align-items:center; gap:3px; font-size:10px; font-weight:700; border-radius:6px; padding:2px 6px; margin-top:4px; }
.ps-paid        { background:#d4edda; color:#155724; }
.ps-proc        { background:#d1ecf1; color:#0c5460; }
.ps-pending     { background:#fff3cd; color:#856404; }
.ps-fail        { background:#f8d7da; color:#721c24; }
.payout-breakdown { background:var(--mist); border-radius:10px; padding:8px 10px; margin-top:6px; font-size:11px; color:#666; }
.payout-breakdown-row { display:flex; justify-content:space-between; padding:2px 0; }
.payout-breakdown-row.net { font-weight:700; color:var(--forest); border-top:1px solid var(--sand); margin-top:3px; padding-top:4px; }

/* ── FORM VALIDATION ── */
.fg input, .fg select { padding:9px 11px; border:1.5px solid var(--sand); border-radius:10px; font-size:14px; font-family:var(--font-body); outline:none; transition:border-color .17s,box-shadow .17s; }
.fg input:focus, .fg select:focus { border-color:var(--mint); }
.fg input.err, .fg select.err { border-color:var(--terra); box-shadow:0 0 0 3px rgba(193,68,14,.12); }
.field-err { font-size:11px; color:var(--terra); margin-top:3px; font-weight:600; }

.frow { display:flex; gap:10px; }
.photo-up { border:2px dashed var(--sand); border-radius:12px; padding:22px 16px; text-align:center; cursor:pointer; transition:border-color .2s; }
.photo-up:hover { border-color:var(--mint); }
.photo-up .pi { font-size:32px; }
.photo-up p { font-size:13px; color:#888; margin-top:7px; }
.photo-up strong { color:var(--leaf); }

/* ── Photo Upload ── */
.pu-zone    { border:2px dashed var(--sand); border-radius:14px; padding:18px 14px; text-align:center; cursor:pointer; transition:all .2s; background:white; position:relative; overflow:hidden; }
.pu-zone:hover,.pu-zone.drag { border-color:var(--leaf); background:var(--mist); }
.pu-zone input[type=file] { position:absolute; inset:0; opacity:0; cursor:pointer; width:100%; height:100%; }
.pu-icon  { font-size:36px; margin-bottom:8px; }
.pu-label { font-size:13px; color:#888; }
.pu-label strong { color:var(--leaf); display:block; margin-bottom:3px; }
.pu-hint  { font-size:10px; color:#bbb; margin-top:5px; }
.pu-previews { display:grid; grid-template-columns:repeat(3,1fr); gap:8px; margin-top:10px; }
.pu-thumb { position:relative; border-radius:10px; overflow:hidden; aspect-ratio:1; background:var(--mist); }
.pu-thumb img { width:100%; height:100%; object-fit:cover; display:block; }
.pu-thumb-remove { position:absolute; top:4px; right:4px; background:rgba(0,0,0,.55); color:white; border:none; border-radius:50%; width:22px; height:22px; font-size:13px; cursor:pointer; display:flex; align-items:center; justify-content:center; line-height:1; }
.pu-progress-wrap { margin-top:8px; }
.pu-progress-bar  { height:4px; background:var(--sand); border-radius:4px; overflow:hidden; margin-top:4px; }
.pu-progress-fill { height:100%; background:var(--leaf); border-radius:4px; transition:width .3s; }
.pu-status  { font-size:11px; color:var(--bark); margin-top:6px; display:flex; align-items:center; gap:5px; }
.pu-status.ok  { color:#27ae60; }
.pu-status.err { color:#c0392b; }
.tgl-row { display:flex; align-items:center; justify-content:space-between; padding:7px 0; }
.tgl-lbl { font-size:13px; }
.tgl-lbl span { font-size:11px; color:#aaa; display:block; }
.tgl { width:41px; height:22px; border-radius:11px; background:var(--sand); border:none; cursor:pointer; position:relative; transition:background .2s; flex-shrink:0; }
.tgl.on { background:var(--mint); }
.tgl::after { content:''; position:absolute; top:2px; left:2px; width:18px; height:18px; border-radius:50%; background:white; transition:transform .2s var(--spring); box-shadow:0 1px 4px rgba(0,0,0,.2); }
.tgl.on::after { transform:translateX(19px); }
.wallet-row { display:flex; align-items:center; gap:10px; background:linear-gradient(135deg,#1a7a3d,#0d5a2c); border-radius:12px; padding:13px 15px; color:white; margin-bottom:13px; }
.wallet-icon { font-size:24px; }
.wallet-name { font-size:13px; font-weight:600; }
.wallet-num { font-size:11px; opacity:.65; margin-top:1px; }
.wallet-bal { font-family:var(--font-head); font-size:19px; margin-left:auto; }
.conv-preview { background:var(--mist); border-radius:10px; padding:10px 12px; font-size:12px; color:var(--bark); line-height:1.9; margin-bottom:11px; }
.submit-btn { width:100%; background:linear-gradient(135deg,var(--forest),var(--leaf)); color:white; border:none; border-radius:14px; padding:14px; font-size:14px; font-weight:600; cursor:pointer; font-family:var(--font-body); transition:opacity .2s; }
.submit-btn:hover { opacity:.88; }
.success-bann { background:var(--mint); color:var(--forest); border-radius:12px; padding:12px 15px; font-size:14px; font-weight:600; display:flex; align-items:center; gap:8px; margin-bottom:13px; animation:slideDown .35s var(--spring); }
@keyframes slideDown { from{transform:translateY(-18px);opacity:0} to{transform:translateY(0);opacity:1} }

/* ── HUB ── */
.hub { padding:20px; }
.hub h2 { font-family:var(--font-head); font-size:23px; color:var(--forest); }
.hub .sub { font-size:13px; color:#888; margin-top:4px; margin-bottom:17px; }
.hub-stats { display:grid; grid-template-columns:repeat(3,1fr); gap:9px; margin-bottom:17px; }
.hub-stat { background:white; border-radius:14px; padding:13px; text-align:center; box-shadow:var(--shadow-sm); }
.hsv { font-family:var(--font-head); font-size:25px; }
.hsv.green{color:var(--leaf)} .hsv.gold{color:var(--gold)} .hsv.terra{color:var(--terra)}
.hsl { font-size:11px; color:#aaa; margin-top:2px; }
.ship-card { background:white; border-radius:14px; padding:13px; box-shadow:var(--shadow-sm); margin-bottom:9px; display:flex; gap:11px; }
.ship-emoji { font-size:32px; flex-shrink:0; }
.ship-name { font-weight:600; font-size:14px; }
.ship-meta { font-size:12px; color:#aaa; margin-top:2px; }
.ship-status { display:inline-flex; align-items:center; gap:4px; padding:3px 9px; border-radius:20px; font-size:11px; font-weight:600; margin-top:8px; }
.sp{background:#fff3cd;color:#856404} .sq{background:#d1ecf1;color:#0c5460}
.sg{background:#d4edda;color:#155724} .st{background:#e2d9f3;color:#4a235a}
.qc-acts { display:flex; gap:7px; margin-top:8px; }
.btn-app { flex:1; background:var(--mint); color:var(--forest); border:none; border-radius:8px; padding:7px; font-size:12px; font-weight:600; cursor:pointer; font-family:var(--font-body); transition:background .17s; }
.btn-app:hover { background:var(--leaf); color:white; }
.btn-rej { background:#fde8e8; color:var(--terra); border:none; border-radius:8px; padding:7px 11px; font-size:12px; font-weight:600; cursor:pointer; font-family:var(--font-body); }

.cart-panel { position:fixed; right:0; top:60px; bottom:64px; width:308px; background:white; z-index:150; box-shadow:-6px 0 28px rgba(0,0,0,.13); animation:slideLeft .3s var(--spring); display:flex; flex-direction:column; }
@keyframes slideLeft { from{transform:translateX(100%)} to{transform:translateX(0)} }
.cart-head { padding:16px 17px 12px; border-bottom:1px solid var(--sand); display:flex; align-items:center; justify-content:space-between; }
.cart-head h3 { font-family:var(--font-head); font-size:18px; color:var(--forest); }
.cart-close { background:none; border:none; font-size:18px; cursor:pointer; color:#aaa; }
.cart-items { flex:1; overflow-y:auto; padding:13px 16px; }
.cart-item { display:flex; gap:9px; padding:9px 0; border-bottom:1px solid var(--sand); }
.ci-emoji { font-size:24px; flex-shrink:0; }
.ci-name { font-size:13px; font-weight:600; }
.ci-farmer { font-size:11px; color:var(--leaf); }
.ci-price { font-size:13px; color:var(--forest); font-weight:600; margin-top:2px; }
.ci-tzs { font-size:10px; color:#ccc; }
.ci-note { font-size:10px; color:var(--gold); font-weight:600; margin-top:1px; }
.cart-foot { padding:13px 16px; border-top:1px solid var(--sand); }
.cart-sub { display:flex; justify-content:space-between; font-size:12px; color:#aaa; margin-bottom:4px; }
.cart-tot { display:flex; justify-content:space-between; font-weight:700; font-size:16px; color:var(--forest); margin-bottom:4px; }
.cart-note { font-size:10px; color:var(--gold); margin:5px 0 10px; font-weight:600; }
.cart-empty { text-align:center; padding:36px 14px; color:#ccc; }
.cart-empty .ce { font-size:42px; }
.cart-empty p { margin-top:10px; font-size:13px; }
.chk-btn-main { width:100%; background:var(--forest); color:white; border:none; border-radius:14px; padding:14px; font-size:14px; font-weight:700; cursor:pointer; font-family:var(--font-body); transition:background .18s; display:flex; align-items:center; justify-content:center; gap:8px; margin-top:2px; }
.chk-btn-main:hover { background:var(--leaf); }

.undo-bar { display:flex; align-items:center; justify-content:space-between; background:#333; color:white; border-radius:10px; padding:8px 12px; font-size:12px; margin-top:6px; animation:slideDown .25s var(--spring); }
.undo-btn { background:var(--mint); color:var(--forest); border:none; border-radius:8px; padding:4px 12px; font-size:12px; font-weight:700; cursor:pointer; font-family:var(--font-body); }

/* ── PAYMENT GATEWAY ── */
.pay-backdrop { position:fixed; inset:0; background:rgba(0,0,0,.6); z-index:500; display:flex; align-items:flex-end; justify-content:center; animation:fadeIn .2s; }
.pay-sheet { background:white; border-radius:28px 28px 0 0; width:100%; max-width:480px; animation:slideUp .32s var(--spring); max-height:96vh; overflow-y:auto; padding-bottom:env(safe-area-inset-bottom,20px);  -webkit-overflow-scrolling:touch; overscroll-behavior:contain; }
.pay-handle { width:38px; height:4px; background:#e0e0e0; border-radius:2px; margin:13px auto 0; }
.pay-header { padding:18px 22px 14px; border-bottom:1px solid #f0f0f0; display:flex; align-items:center; gap:12px; }
.pay-header-icon { width:44px; height:44px; background:linear-gradient(135deg,var(--forest),var(--leaf)); border-radius:14px; display:flex; align-items:center; justify-content:center; font-size:20px; flex-shrink:0; }
.pay-header-title { font-family:var(--font-head); font-size:20px; color:var(--forest); }
.pay-header-sub { font-size:12px; color:#aaa; margin-top:2px; }
.pay-close { margin-left:auto; background:none; border:none; font-size:20px; cursor:pointer; color:#bbb; padding:4px; }
.pay-summary { margin:14px 22px; background:var(--mist); border-radius:14px; padding:14px 16px; display:flex; align-items:center; justify-content:space-between; border:1px solid var(--sand); }
.pay-summary-label { font-size:12px; color:#888; }
.pay-summary-amount { font-family:var(--font-head); font-size:22px; color:var(--forest); }
.pay-summary-tzs { font-size:11px; color:var(--leaf); font-weight:600; margin-top:2px; }
.pay-summary-items { font-size:11px; color:#aaa; }
.pay-section-title { font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.8px; color:#aaa; padding:0 22px 10px; }
.pay-express-row { display:grid; grid-template-columns:1fr 1fr; gap:10px; padding:0 22px 10px; }
.pay-express-btn { border:1.5px solid #e8e8e8; border-radius:16px; padding:14px 10px; display:flex; align-items:center; justify-content:center; gap:7px; cursor:pointer; font-family:var(--font-body); font-size:14px; font-weight:700; transition:all .22s var(--spring); background:white; letter-spacing:-.3px; }
.pay-express-btn:hover { transform:translateY(-3px); box-shadow:0 8px 24px rgba(0,0,0,.14); }
.pay-express-btn:active { transform:scale(.96); }
.pay-express-btn.apple { background:#000; color:white; border-color:#000; }
.pay-express-btn.apple:hover { background:#1a1a1a; }
.pay-express-btn.google { background:white; color:#3c4043; border-color:#dadce0; }
.apple-logo-wrap { display:flex; align-items:center; gap:5px; }
.apple-symbol { font-size:18px; margin-top:-2px; }
.apple-text { font-size:15px; font-weight:600; }
.gpay-logo { display:flex; align-items:center; gap:1px; font-size:15px; font-weight:700; }
.gpay-logo .g{color:#4285F4} .gpay-logo .o1{color:#EA4335} .gpay-logo .o2{color:#FBBC05} .gpay-logo .g2{color:#34A853} .gpay-logo .le{color:#4285F4} .gpay-logo .pay{color:#5f6368;font-size:13px;margin-left:3px}
.pay-express-paypal { margin:0 22px 16px; border:1.5px solid #ffc439; border-radius:16px; padding:13px; display:flex; align-items:center; justify-content:center; gap:6px; cursor:pointer; font-family:var(--font-body); font-size:14px; font-weight:700; background:#ffc439; color:#003087; box-shadow:0 2px 8px rgba(255,196,57,.3); transition:all .22s var(--spring); }
.pay-express-paypal:hover { background:#f0b429; transform:translateY(-2px); box-shadow:0 8px 24px rgba(255,196,57,.5); }
.paypal-logo { display:flex; align-items:center; gap:1px; font-size:16px; font-weight:900; font-style:italic; }
.paypal-logo .pp{color:#003087} .paypal-logo .pp2{color:#009cde}
.pay-or { display:flex; align-items:center; gap:10px; padding:0 22px 16px; }
.pay-or-line { flex:1; height:1px; background:#f0f0f0; }
.pay-or-text { font-size:11px; color:#ccc; font-weight:600; }
.pay-methods { padding:0 22px 14px; display:flex; flex-direction:column; gap:8px; }
.pay-method { display:flex; align-items:center; gap:12px; padding:14px 16px; border:1.5px solid #efefef; border-radius:14px; cursor:pointer; transition:all .18s; background:white; }
.pay-method:hover { border-color:var(--mint); background:var(--mist); }
.pay-method.selected { border-color:var(--forest); background:linear-gradient(135deg,rgba(26,58,42,.03),rgba(82,183,136,.06)); }
.pay-method-icon { width:40px; height:40px; border-radius:10px; display:flex; align-items:center; justify-content:center; font-size:20px; flex-shrink:0; }
.pay-method-icon.mpesa{background:linear-gradient(135deg,#00a651,#007a3d)} .pay-method-icon.tigopesa{background:linear-gradient(135deg,#00aeef,#0077b6)} .pay-method-icon.selcom{background:linear-gradient(135deg,#00a651,#34d399)} .pay-method-icon.airtel{background:linear-gradient(135deg,#e40000,#ff6b6b)} .pay-method-icon.card{background:linear-gradient(135deg,#667eea,#764ba2)} .pay-method-icon.bank{background:linear-gradient(135deg,#f7971e,#ffd200)}
.pay-method-name { font-weight:600; font-size:14px; color:var(--charcoal); }
.pay-method-sub  { font-size:11px; color:#aaa; margin-top:1px; }
.pay-method-radio { margin-left:auto; width:20px; height:20px; border-radius:50%; border:2px solid #ddd; display:flex; align-items:center; justify-content:center; flex-shrink:0; transition:all .18s; }
.pay-method.selected .pay-method-radio { border-color:var(--forest); background:var(--forest); }
.pay-method-radio::after { content:''; width:8px; height:8px; border-radius:50%; background:white; opacity:0; transition:opacity .15s; }
.pay-method.selected .pay-method-radio::after { opacity:1; }
.card-form { margin:0 22px 14px; background:var(--mist); border-radius:16px; padding:16px; animation:slideDown .25s var(--spring); }
.card-form-title { font-size:12px; font-weight:700; color:var(--bark); text-transform:uppercase; letter-spacing:.5px; margin-bottom:12px; }
.card-visual { background:linear-gradient(135deg,#1a3a2a 0%,#2d6a4f 60%,#52b788 100%); border-radius:16px; padding:18px 20px; margin-bottom:14px; position:relative; overflow:hidden; min-height:100px; }
.card-visual::before { content:''; position:absolute; right:-20px; top:-20px; width:120px; height:120px; border-radius:50%; background:rgba(255,255,255,.07); }
.card-visual-chip { font-size:22px; margin-bottom:10px; }
.card-visual-num { font-size:16px; font-weight:600; color:white; letter-spacing:2px; font-family:monospace; }
.card-visual-bottom { display:flex; justify-content:space-between; margin-top:10px; align-items:flex-end; }
.card-visual-label { font-size:9px; color:rgba(255,255,255,.55); text-transform:uppercase; letter-spacing:.5px; }
.card-visual-value { font-size:13px; color:white; font-weight:600; margin-top:2px; }
.card-visual-brand { font-size:18px; font-weight:700; color:white; }
.cfield { display:flex; flex-direction:column; gap:5px; margin-bottom:10px; }
.cfield label { font-size:10px; font-weight:700; color:var(--bark); text-transform:uppercase; letter-spacing:.4px; }
.cfield input { padding:10px 12px; border:1.5px solid #e0e0e0; border-radius:10px; font-size:14px; font-family:monospace; background:white; outline:none; transition:border-color .17s; }
.cfield input:focus { border-color:var(--mint); }
.cfield-row { display:flex; gap:10px; }
.momo-form { margin:0 22px 14px; background:var(--mist); border-radius:16px; padding:16px; animation:slideDown .25s var(--spring); }
.momo-hint { font-size:12px; color:#888; line-height:1.6; margin-bottom:12px; }
.momo-input-wrap { position:relative; }
.momo-input-wrap input { width:100%; padding:12px 14px 12px 48px; border:1.5px solid #e0e0e0; border-radius:12px; font-size:15px; font-family:var(--font-body); background:white; outline:none; transition:border-color .17s; }
.momo-input-wrap input:focus { border-color:var(--mint); }
.momo-flag { position:absolute; left:14px; top:50%; transform:translateY(-50%); font-size:18px; }
.momo-push-note { background:white; border-radius:10px; padding:10px 13px; font-size:12px; color:var(--bark); margin-top:10px; line-height:1.6; border:1px solid var(--sand); display:flex; gap:8px; align-items:flex-start; }
.momo-push-note .ni { font-size:16px; flex-shrink:0; }
.bank-form { margin:0 22px 14px; background:var(--mist); border-radius:16px; padding:16px; animation:slideDown .25s var(--spring); }
.bank-detail-row { display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px solid #ece8df; font-size:13px; }
.bank-detail-row:last-child { border-bottom:none; }
.bank-detail-label { color:#888; }
.bank-detail-value { font-weight:600; color:var(--forest); }
.pay-confirm-btn { margin:4px 22px 20px; width:calc(100% - 44px); background:linear-gradient(135deg,var(--forest),var(--leaf)); color:white; border:none; border-radius:16px; padding:17px; font-size:15px; font-weight:700; cursor:pointer; font-family:var(--font-body); transition:all .2s; display:flex; align-items:center; justify-content:center; gap:8px; box-shadow:0 4px 20px rgba(26,58,42,.25); }
.pay-confirm-btn:hover { transform:translateY(-2px); box-shadow:0 8px 28px rgba(26,58,42,.35); }
.pay-security { display:flex; align-items:center; justify-content:center; gap:14px; padding:0 22px 8px; flex-wrap:wrap; }
.pay-sec-badge { display:flex; align-items:center; gap:5px; font-size:11px; color:#bbb; }

/* ── Address Picker ── */
.addr-wrap   { margin:0 22px 14px; }
.addr-label  { font-size:11px; font-weight:700; color:var(--bark); text-transform:uppercase; letter-spacing:.6px; margin-bottom:8px; display:flex; align-items:center; gap:6px; }
.addr-input-row { display:flex; gap:8px; }
.addr-input  { flex:1; border:1.5px solid var(--sand); border-radius:12px; padding:11px 13px; font-size:14px; font-family:var(--font-body); outline:none; transition:border-color .17s; min-width:0; }
.addr-input:focus { border-color:var(--leaf); }
.addr-input.error { border-color:#c0392b; }
.addr-gps-btn { background:var(--forest); color:white; border:none; border-radius:12px; padding:11px 14px; font-size:17px; cursor:pointer; flex-shrink:0; transition:background .17s; }
.addr-gps-btn:hover { background:var(--leaf); }
.addr-gps-btn:disabled { opacity:.5; cursor:not-allowed; }
.addr-map-wrap  { margin-top:10px; border-radius:14px; overflow:hidden; border:1.5px solid var(--sand); position:relative; height:200px; background:#e8f5e9; }
.addr-map-inner { width:100%; height:100%; display:flex; align-items:center; justify-content:center; flex-direction:column; gap:8px; }
.addr-pin    { font-size:36px; animation:pinDrop .4s var(--spring); }
@keyframes pinDrop { 0%{transform:translateY(-20px);opacity:0} 100%{transform:translateY(0);opacity:1} }
.addr-coords { font-size:11px; color:var(--bark); font-family:monospace; }
.addr-w3w    { font-size:12px; color:#9b59b6; font-weight:700; background:#f5eeff; border-radius:8px; padding:4px 10px; margin-top:4px; }
.addr-confirmed { background:var(--mist); border-radius:12px; padding:10px 13px; font-size:12px; color:var(--charcoal); margin-top:8px; display:flex; align-items:flex-start; gap:8px; border:1px solid var(--sand); }
.addr-confirmed-icon { font-size:18px; flex-shrink:0; margin-top:1px; }
.addr-error  { font-size:11px; color:#c0392b; margin-top:6px; }
.pay-success { padding:20px 22px 32px; text-align:center; animation:successPop .5s var(--spring); }
@keyframes successPop { from{opacity:0;transform:scale(.85)} to{opacity:1;transform:scale(1)} }
.success-ring { width:90px; height:90px; border-radius:50%; background:linear-gradient(135deg,var(--mint),var(--leaf)); display:flex; align-items:center; justify-content:center; font-size:42px; margin:20px auto 16px; box-shadow:0 8px 28px rgba(82,183,136,.4); animation:ringPulse 2s ease-in-out infinite; }
@keyframes ringPulse { 0%,100%{box-shadow:0 8px 28px rgba(82,183,136,.4)} 50%{box-shadow:0 8px 40px rgba(82,183,136,.7)} }
.success-title { font-family:var(--font-head); font-size:26px; color:var(--forest); }
.success-sub { font-size:14px; color:#888; margin-top:8px; line-height:1.6; }
.success-amount { font-family:var(--font-head); font-size:32px; color:var(--gold); margin:16px 0 8px; }
.success-ref { display:inline-block; background:var(--mist); border-radius:10px; padding:6px 16px; font-size:12px; color:var(--bark); font-weight:600; margin-top:4px; }
.success-steps { margin:20px 0 0; display:flex; flex-direction:column; gap:10px; text-align:left; }
.success-step { display:flex; gap:12px; align-items:flex-start; background:var(--mist); border-radius:12px; padding:12px 14px; }
.success-step-icon { font-size:20px; flex-shrink:0; }
.success-step-text { font-size:13px; color:var(--charcoal); line-height:1.5; }

/* ── TRA VFD Fiscal Receipt ── */
.vfd-receipt { margin:18px 22px 0; border:2px dashed var(--gold); border-radius:14px; background:#fffdf0; padding:14px 16px; text-align:center; }
.vfd-badge   { display:inline-flex; align-items:center; gap:6px; background:var(--forest); color:white; border-radius:8px; padding:4px 10px; font-size:10px; font-weight:700; letter-spacing:.6px; text-transform:uppercase; margin-bottom:10px; }
.vfd-title   { font-weight:700; font-size:13px; color:var(--forest); margin-bottom:4px; }
.vfd-row     { display:flex; justify-content:space-between; font-size:11px; color:#666; padding:2px 0; border-bottom:1px dotted #e0d5aa; }
.vfd-row:last-child { border-bottom:none; }
.vfd-row span:last-child { font-weight:700; color:var(--charcoal); }
.vfd-qr      { margin:12px auto 8px; width:70px; height:70px; background:var(--forest); border-radius:8px; display:flex; align-items:center; justify-content:center; color:white; font-size:28px; }
.vfd-fn      { font-size:10px; color:#888; font-family:monospace; word-break:break-all; margin-top:4px; }
.vfd-actions { display:flex; gap:8px; margin-top:10px; }
.vfd-btn     { flex:1; padding:8px; border:none; border-radius:10px; font-size:12px; font-weight:700; cursor:pointer; font-family:var(--font-body); }
.vfd-btn.print  { background:var(--forest); color:white; }
.vfd-btn.share  { background:var(--mist);   color:var(--forest); border:1.5px solid var(--forest); }
.vfd-pending { display:flex; align-items:center; gap:8px; justify-content:center; color:var(--bark); font-size:12px; margin:12px 0 4px; }
.vfd-error   { font-size:11px; color:#c0392b; margin-top:8px; text-align:center; }
.success-step-text strong { color:var(--forest); }

/* ── Accessibility ── */
.skip-link { position:absolute; left:-9999px; top:auto; width:1px; height:1px; overflow:hidden; }
.skip-link:focus { position:fixed; top:8px; left:8px; width:auto; height:auto; padding:8px 14px; background:var(--forest); color:white; border-radius:10px; font-size:13px; font-weight:700; z-index:9999; text-decoration:none; outline:3px solid var(--gold); }
.order-hist      { margin:0 0 20px; padding:0 0 4px; }
.order-hist h3   { font-size:13px; font-weight:700; color:var(--forest); margin:18px 0 10px; padding:0 4px; }
.oh-card         { background:white; border-radius:14px; padding:13px 14px; margin-bottom:8px; box-shadow:var(--shadow-sm); border-left:3px solid var(--sand); }
.oh-card.delivered { border-left-color:var(--leaf); }
.oh-header       { display:flex; align-items:center; justify-content:space-between; margin-bottom:6px; }
.oh-id           { font-size:10px; color:#bbb; font-family:monospace; }
.oh-status       { font-size:10px; font-weight:700; border-radius:6px; padding:2px 7px; }
.oh-products     { font-size:12px; color:var(--charcoal); margin-bottom:4px; }
.oh-meta         { font-size:11px; color:#aaa; display:flex; gap:10px; flex-wrap:wrap; }
.oh-review-btn   { margin-top:8px; background:var(--mist); border:1.5px solid var(--sand); border-radius:10px; padding:6px 12px; font-size:12px; font-weight:600; color:var(--forest); cursor:pointer; font-family:var(--font-body); width:100%; }
.oh-review-btn:hover { background:var(--sand); }

/* ── Review / Rating system ── */
.review-modal-bd  { position:fixed; inset:0; background:rgba(0,0,0,.55); z-index:1100; display:flex; align-items:flex-end; justify-content:center; }
.review-modal     { background:white; border-radius:24px 24px 0 0; width:100%; max-width:480px; padding:24px; animation:slideUp .3s var(--spring); max-height:90vh; overflow-y:auto; }
.review-handle    { width:36px; height:4px; background:var(--sand); border-radius:4px; margin:0 auto 20px; }
.review-title     { font-family:var(--font-head); font-size:20px; color:var(--forest); margin-bottom:4px; }
.review-sub       { font-size:13px; color:#888; margin-bottom:18px; }
.review-stars     { display:flex; gap:8px; margin-bottom:18px; }
.review-star      { font-size:36px; cursor:pointer; transition:transform .15s; line-height:1; }
.review-star:hover,.review-star.active { transform:scale(1.25); }
.review-labels    { display:flex; justify-content:space-between; font-size:10px; color:#aaa; margin-top:-12px; margin-bottom:14px; }
.review-textarea  { width:100%; border:1.5px solid var(--sand); border-radius:12px; padding:11px 13px; font-size:14px; font-family:var(--font-body); outline:none; resize:none; transition:border-color .17s; box-sizing:border-box; }
.review-textarea:focus { border-color:var(--leaf); }
.review-char      { font-size:10px; color:#bbb; text-align:right; margin-top:4px; margin-bottom:14px; }
.review-submit    { width:100%; background:var(--forest); color:white; border:none; border-radius:14px; padding:14px; font-size:14px; font-weight:700; cursor:pointer; font-family:var(--font-body); transition:background .17s; }
.review-submit:hover { background:var(--leaf); }
.review-submit:disabled { background:#ccc; color:#888; cursor:not-allowed; }
.review-skip      { width:100%; background:none; border:none; color:#aaa; font-size:12px; cursor:pointer; padding:10px; font-family:var(--font-body); margin-top:6px; }
/* Review display on product cards / modal */
.review-item      { padding:10px 0; border-bottom:1px solid var(--sand); }
.review-item:last-child { border-bottom:none; }
.review-item-header { display:flex; align-items:center; justify-content:space-between; margin-bottom:4px; }
.review-stars-display { color:var(--gold); font-size:14px; letter-spacing:1px; }
.review-customer  { font-size:11px; color:#aaa; }
.review-text      { font-size:13px; color:var(--charcoal); line-height:1.5; }
.review-date      { font-size:10px; color:#bbb; margin-top:3px; }

/* ── Error Boundary fallback screen ── */
.eb-wrap  { min-height:100vh; display:flex; align-items:center; justify-content:center; background:var(--mist); padding:24px; }
.eb-card  { background:white; border-radius:20px; padding:32px 24px; max-width:380px; width:100%; text-align:center; box-shadow:0 8px 40px rgba(0,0,0,.12); }
.eb-icon  { font-size:56px; margin-bottom:16px; }
.eb-title { font-family:var(--font-head); font-size:22px; color:var(--forest); margin-bottom:8px; }
.eb-sub   { font-size:14px; color:#888; line-height:1.6; margin-bottom:20px; }
.eb-ref   { font-family:monospace; font-size:11px; color:#bbb; background:var(--mist); border-radius:8px; padding:6px 10px; display:inline-block; margin-bottom:20px; word-break:break-all; }
.eb-detail{ font-size:11px; color:#c0392b; background:#fff0f0; border-radius:8px; padding:8px 12px; text-align:left; margin-bottom:20px; font-family:monospace; overflow-x:auto; white-space:pre-wrap; }
.eb-btn   { width:100%; border:none; border-radius:12px; padding:14px; font-size:14px; font-weight:700; cursor:pointer; font-family:var(--font-body); margin-bottom:8px; }
.eb-btn.primary   { background:var(--forest); color:white; }
.eb-btn.secondary { background:var(--mist); color:var(--forest); }
.success-close { margin-top:20px; width:100%; background:var(--forest); color:white; border:none; border-radius:14px; padding:15px; font-size:14px; font-weight:700; cursor:pointer; font-family:var(--font-body); }
.processing-screen { padding:50px 22px; text-align:center; }
.spinner { width:52px; height:52px; border:4px solid var(--sand); border-top-color:var(--leaf); border-radius:50%; animation:spin .8s linear infinite; margin:0 auto 20px; }
@keyframes spin { to{transform:rotate(360deg)} }
.processing-title { font-family:var(--font-head); font-size:20px; color:var(--forest); margin-bottom:8px; }
.processing-sub { font-size:13px; color:#aaa; }

/* ── RIDER PORTAL ── */
.rider { padding:20px; max-width:600px; margin:0 auto; }
.rider-head h2 { font-family:var(--font-head); font-size:23px; color:var(--forest); }
.rider-head p { font-size:13px; color:#888; margin-top:4px; margin-bottom:16px; }
.role-switch { display:flex; gap:8px; margin-bottom:18px; }
.role-btn { flex:1; padding:10px; border-radius:12px; border:1.5px solid var(--sand); background:white; font-family:var(--font-body); font-size:13px; font-weight:600; cursor:pointer; transition:all .18s; color:var(--bark); text-align:center; }
.role-btn.active { background:var(--forest); color:white; border-color:var(--forest); }
.role-btn:hover:not(.active) { border-color:var(--mint); color:var(--leaf); }

.rider-stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(80px,1fr)); gap:9px; margin-bottom:18px; }
.rider-stat { background:white; border-radius:14px; padding:13px; text-align:center; box-shadow:var(--shadow-sm); }
.rsv { font-family:var(--font-head); font-size:24px; }
.rsv.green{color:var(--leaf)} .rsv.gold{color:var(--gold)} .rsv.terra{color:var(--terra)} .rsv.blue{color:#4285F4}
.rsl { font-size:10px; color:#aaa; margin-top:2px; text-transform:uppercase; letter-spacing:.4px; }
.delivery-card { background:white; border-radius:16px; padding:16px; box-shadow:var(--shadow-sm); margin-bottom:12px; border-left:4px solid transparent; transition:all .2s; position:relative; overflow:hidden; }
.delivery-card.available{border-left-color:var(--mint)} .delivery-card.assigned{border-left-color:var(--gold)} .delivery-card.picked-up{border-left-color:#4285F4} .delivery-card.delivered{border-left-color:var(--leaf)} .delivery-card.cancelled{border-left-color:var(--terra);opacity:.65}
.dc-top { display:flex; align-items:flex-start; justify-content:space-between; gap:10px; }
.dc-id { font-size:10px; font-weight:700; color:#bbb; letter-spacing:.5px; }
.dc-status { display:inline-flex; align-items:center; gap:4px; padding:3px 10px; border-radius:20px; font-size:10px; font-weight:700; flex-shrink:0; }
.ds-available{background:#d4edda;color:#155724} .ds-assigned{background:#fff3cd;color:#856404} .ds-picked-up{background:#cfe2ff;color:#084298} .ds-delivered{background:#d4edda;color:#0a3622} .ds-cancelled{background:#f8d7da;color:#842029}
.dc-products { display:flex; gap:6px; margin:8px 0; flex-wrap:wrap; }
.dc-product-tag { background:var(--mist); border-radius:8px; padding:3px 9px; font-size:12px; font-weight:500; color:var(--bark); display:flex; align-items:center; gap:4px; }
.dc-route { display:flex; align-items:center; gap:6px; font-size:12px; color:#888; margin:8px 0; flex-wrap:wrap; }
.dc-route .from{color:var(--forest);font-weight:600} .dc-route .to{color:var(--terra);font-weight:600} .dc-route .arr{color:#888;font-size:16px}
.dc-meta { display:flex; gap:14px; margin-top:8px; flex-wrap:wrap; }
.dc-meta-item { font-size:11px; color:#aaa; display:flex; align-items:center; gap:3px; }
.dc-meta-item strong { color:var(--charcoal); }
.dc-actions { display:flex; gap:8px; margin-top:12px; }
.dc-btn { flex:1; padding:9px; border-radius:10px; font-size:12px; font-weight:700; cursor:pointer; font-family:var(--font-body); border:none; transition:all .18s; display:flex; align-items:center; justify-content:center; gap:5px; }
.dc-btn.accept{background:var(--mint);color:var(--forest)} .dc-btn.accept:hover{background:var(--leaf);color:white}
.dc-btn.pickup{background:#4285F4;color:white} .dc-btn.pickup:hover{background:#2c6fe0}
.dc-btn.complete{background:var(--leaf);color:white} .dc-btn.complete:hover{background:var(--forest)}
.dc-btn.cancel{background:#fde8e8;color:var(--terra)} .dc-btn.cancel:hover{background:#f8d7da}
.dc-btn.view-only{background:var(--mist);color:var(--bark);cursor:default}

.dc-btn:disabled { opacity:.4; cursor:not-allowed; transform:none !important; }
.assign-row { display:flex; gap:8px; align-items:center; margin-top:10px; flex-wrap:wrap; }
.assign-select { flex:1; padding:8px 11px; border:1.5px solid var(--sand); border-radius:10px; font-size:13px; font-family:var(--font-body); outline:none; background:white; min-width:140px; }
.assign-select:focus { border-color:var(--mint); }
.assign-btn { padding:8px 16px; background:var(--forest); color:white; border:none; border-radius:10px; font-size:12px; font-weight:700; cursor:pointer; font-family:var(--font-body); white-space:nowrap; transition:background .18s; }
.assign-btn:hover { background:var(--leaf); }
.assign-btn.unassign { background:#fde8e8; color:var(--terra); }
.assign-btn.unassign:hover { background:#f8d7da; }
.rider-profile { background:linear-gradient(135deg,var(--forest),var(--leaf)); border-radius:16px; padding:16px; color:white; margin-bottom:16px; display:flex; gap:14px; align-items:center; }
.rider-avatar { width:52px; height:52px; border-radius:50%; background:rgba(255,255,255,.2); display:flex; align-items:center; justify-content:center; font-size:24px; flex-shrink:0; }
.rider-name { font-family:var(--font-head); font-size:18px; }
.rider-meta { font-size:12px; opacity:.75; margin-top:3px; }
.rider-online { display:inline-flex; align-items:center; gap:5px; background:rgba(255,255,255,.15); border-radius:20px; padding:3px 10px; font-size:11px; margin-top:6px; }
.online-dot { width:7px; height:7px; border-radius:50%; background:#52b788; animation:pulse 1.5s ease-in-out infinite; }
@keyframes pulse { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:.6;transform:scale(1.3)} }
.earnings-card { background:white; border-radius:14px; padding:14px 16px; box-shadow:var(--shadow-sm); display:flex; justify-content:space-between; align-items:center; margin-bottom:16px; }
.earn-label { font-size:12px; color:#aaa; }
.earn-val { font-family:var(--font-head); font-size:20px; color:var(--gold); margin-top:3px; }
.earn-note { font-size:10px; color:var(--mint); margin-top:2px; font-weight:600; }

/* ── TOAST ── */
.toast { position:fixed; bottom:78px; left:50%; transform:translateX(-50%); background:var(--forest); color:white; border-radius:12px; padding:10px 20px; font-size:13px; font-weight:600; z-index:600; white-space:nowrap; animation:toastIn .3s var(--spring); box-shadow:0 8px 24px rgba(26,58,42,.3); }
@keyframes toastIn { from{opacity:0;transform:translateX(-50%) translateY(20px)} to{opacity:1;transform:translateX(-50%) translateY(0)} }

/* ── PER-TAB SHIMMER ── */
.tab-shimmer { padding:18px 18px 0; display:grid; grid-template-columns:repeat(auto-fill,minmax(165px,1fr)); gap:13px; }

/* ══════════════════════════════════════════
AGRIPASS — INSPECTION SYSTEM
══════════════════════════════════════════ */
.ap-wrap { padding:0 0 24px; max-width:620px; margin:0 auto; }

/* Header strip */
.ap-header {
background:linear-gradient(135deg,#0d3321 0%,#1a5c36 55%,#2d8a55 100%);
padding:22px 20px 18px; position:relative; overflow:hidden;
}
.ap-header::after { content:"🌿"; position:absolute; right:18px; bottom:-6px; font-size:76px; opacity:.14; }
.ap-brand { display:flex; align-items:center; gap:10px; margin-bottom:6px; }
.ap-logo-ring {
width:40px; height:40px; border-radius:12px; background:rgba(255,255,255,.18);
display:flex; align-items:center; justify-content:center; font-size:20px; flex-shrink:0;
}
.ap-title { font-family:var(--font-head); font-size:22px; color:white; letter-spacing:-.3px; }
.ap-subtitle { font-size:12px; color:rgba(255,255,255,.65); }
.ap-tabs { display:flex; gap:5px; margin-top:14px; }
.ap-tab {
flex:1; padding:8px 4px; border-radius:10px; border:1.5px solid rgba(255,255,255,.2);
background:rgba(255,255,255,.08); color:rgba(255,255,255,.7);
font-size:11px; font-weight:600; cursor:pointer; font-family:var(--font-body);
transition:all .18s; text-align:center;
}
.ap-tab.active { background:white; color:#0d3321; border-color:white; }
.ap-tab:hover:not(.active) { background:rgba(255,255,255,.18); color:white; }

/* Stats bar */
.ap-stats { display:grid; grid-template-columns:repeat(4,1fr); gap:8px; padding:14px 16px; }
.ap-stat { background:white; border-radius:12px; padding:10px; text-align:center; box-shadow:var(--shadow-sm); }
.ap-stat-val { font-family:var(--font-head); font-size:22px; }
.ap-stat-val.green{color:#155724} .ap-stat-val.red{color:#842029} .ap-stat-val.gold{color:#856404} .ap-stat-val.blue{color:#0c5460}
.ap-stat-lbl { font-size:10px; color:#aaa; margin-top:1px; text-transform:uppercase; letter-spacing:.4px; }

/* Section label */
.ap-sec { padding:10px 16px 8px; font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:1px; color:var(--bark); display:flex; align-items:center; gap:8px; }
.ap-sec::after { content:''; flex:1; height:1px; background:var(--sand); }

/* Search + filter row */
.ap-search-row { display:flex; gap:8px; padding:0 16px 10px; }
.ap-search { display:flex; align-items:center; gap:6px; background:white; border-radius:10px; padding:8px 12px; flex:1; box-shadow:var(--shadow-sm); }
.ap-search input { border:none; outline:none; font-size:13px; font-family:var(--font-body); background:transparent; flex:1; }
.ap-filter { padding:8px 12px; border-radius:10px; border:1.5px solid var(--sand); background:white; font-family:var(--font-body); font-size:12px; outline:none; }

/* Queue card */
.ap-card {
margin:0 16px 10px; background:white; border-radius:14px; padding:14px;
box-shadow:var(--shadow-sm); border-left:4px solid var(--sand); transition:all .18s;
}
.ap-card.pending  { border-left-color:#856404; }
.ap-card.approved { border-left-color:#155724; }
.ap-card.rejected { border-left-color:#842029; }
.ap-card-top { display:flex; align-items:flex-start; justify-content:space-between; gap:8px; }
.ap-card-id  { font-size:10px; font-weight:700; color:#bbb; letter-spacing:.5px; }
.ap-card-name { font-weight:700; font-size:15px; color:var(--charcoal); margin-top:2px; }
.ap-card-sub  { font-size:12px; color:var(--leaf); margin-top:2px; }
.ap-card-meta { display:flex; gap:12px; margin-top:8px; flex-wrap:wrap; }
.ap-card-meta span { font-size:11px; color:#aaa; display:flex; align-items:center; gap:3px; }
.ap-card-meta strong { color:var(--charcoal); }
.ap-status-pill {
display:inline-flex; align-items:center; gap:4px;
padding:3px 10px; border-radius:20px; font-size:10px; font-weight:700; flex-shrink:0;
}
.ap-pending  { background:#fff3cd; color:#856404; }
.ap-approved { background:#d4edda; color:#155724; }
.ap-rejected { background:#f8d7da; color:#842029; }
.ap-btn-inspect {
margin-top:10px; width:100%; background:linear-gradient(135deg,#0d3321,#1a5c36);
color:white; border:none; border-radius:10px; padding:9px;
font-size:12px; font-weight:700; cursor:pointer; font-family:var(--font-body); transition:opacity .18s;
}
.ap-btn-inspect:hover { opacity:.88; }
.ap-btn-cert {
margin-top:10px; width:100%; background:var(--mist);
color:#0d3321; border:1.5px solid #2d8a55; border-radius:10px; padding:9px;
font-size:12px; font-weight:700; cursor:pointer; font-family:var(--font-body); transition:all .18s;
}
.ap-btn-cert:hover { background:#d4edda; }

/* Inspection form modal */
.ap-modal-bd { position:fixed; inset:0; background:rgba(0,0,0,.6); z-index:300; display:flex; align-items:flex-end; justify-content:center; animation:fadeIn .2s; }
.ap-modal { background:white; border-radius:24px 24px 0 0; width:100%; max-width:580px; max-height:94vh; overflow-y:auto; animation:slideUp .3s var(--spring); padding-bottom:24px; }
.ap-modal-handle { width:38px; height:4px; background:#ddd; border-radius:2px; margin:12px auto 0; }
.ap-modal-head { padding:16px 20px 12px; border-bottom:1px solid var(--sand); display:flex; align-items:center; justify-content:space-between; }
.ap-modal-title { font-family:var(--font-head); font-size:20px; color:#0d3321; }
.ap-modal-close { background:none; border:none; font-size:20px; cursor:pointer; color:#aaa; }
.ap-modal-body { padding:16px 20px 0; }

/* Grade selector */
.ap-grade-row { margin-bottom:12px; }
.ap-grade-label { font-size:11px; font-weight:700; color:var(--bark); text-transform:uppercase; letter-spacing:.5px; margin-bottom:6px; }
.ap-grade-btns { display:flex; gap:6px; }
.ap-grade-btn {
flex:1; padding:8px 4px; border-radius:9px; border:1.5px solid var(--sand);
background:white; font-size:13px; font-weight:700; cursor:pointer; font-family:var(--font-body);
transition:all .15s; text-align:center;
}
.ap-grade-btn.selected { color:white; border-color:transparent; }
.ap-grade-btn[data-g="A"].selected { background:#155724; }
.ap-grade-btn[data-g="B"].selected { background:#0c5460; }
.ap-grade-btn[data-g="C"].selected { background:#856404; }
.ap-grade-btn[data-g="F"].selected { background:#842029; }

/* Decision + rejection form */
.ap-decision { display:flex; gap:8px; margin:14px 0; }
.ap-decision-btn {
flex:1; padding:10px; border-radius:12px; font-size:13px; font-weight:700;
cursor:pointer; font-family:var(--font-body); border:2px solid transparent; transition:all .18s;
}
.ap-decision-btn.approve { background:#d4edda; color:#155724; border-color:#c3e6cb; }
.ap-decision-btn.approve.sel { background:#155724; color:white; }
.ap-decision-btn.reject  { background:#f8d7da; color:#842029; border-color:#f5c6cb; }
.ap-decision-btn.reject.sel  { background:#842029; color:white; }
.ap-rejection-form { background:#fff5f5; border-radius:12px; padding:14px; border:1.5px solid #f5c6cb; margin-bottom:12px; animation:slideDown .25s var(--spring); }
.ap-field { margin-bottom:12px; }
.ap-field label { font-size:11px; font-weight:700; color:var(--bark); text-transform:uppercase; letter-spacing:.4px; display:block; margin-bottom:5px; }
.ap-field input, .ap-field select, .ap-field textarea {
width:100%; padding:9px 11px; border:1.5px solid var(--sand); border-radius:10px;
font-size:13px; font-family:var(--font-body); outline:none; transition:border-color .17s;
background:white;
}
.ap-field input:focus, .ap-field select:focus, .ap-field textarea:focus { border-color:#2d8a55; }
.ap-field textarea { min-height:80px; resize:vertical; }
.ap-submit-btn {
width:100%; background:linear-gradient(135deg,#0d3321,#1a5c36); color:white;
border:none; border-radius:12px; padding:14px; font-size:14px; font-weight:700;
cursor:pointer; font-family:var(--font-body); transition:opacity .2s; margin-top:4px;
}
.ap-submit-btn:hover { opacity:.88; }
.ap-submit-btn:disabled { opacity:.4; cursor:not-allowed; }

/* Certificate modal */
.cert-modal-bd { position:fixed; inset:0; background:rgba(0,0,0,.65); z-index:350; display:flex; align-items:flex-end; justify-content:center; animation:fadeIn .2s; }
.cert-sheet { background:white; border-radius:24px 24px 0 0; width:100%; max-width:580px; max-height:96vh; overflow-y:auto; animation:slideUp .3s var(--spring); padding-bottom:32px; }
.cert-header {
background:linear-gradient(135deg,#0d3321,#2d8a55); padding:20px 20px 16px;
display:flex; align-items:center; gap:14px;
}
.cert-stamp {
width:54px; height:54px; border-radius:50%; background:rgba(255,255,255,.22);
border:3px solid rgba(255,255,255,.5); display:flex; align-items:center; justify-content:center;
font-size:26px; flex-shrink:0;
}
.cert-title { font-family:var(--font-head); font-size:20px; color:white; }
.cert-id { font-size:11px; color:rgba(255,255,255,.7); margin-top:2px; letter-spacing:.3px; }
.cert-close { margin-left:auto; background:none; border:none; color:rgba(255,255,255,.7); font-size:20px; cursor:pointer; }
.cert-body { padding:18px 20px 0; }
.cert-row { display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px solid var(--sand); font-size:13px; }
.cert-row:last-child { border-bottom:none; }
.cert-key { color:#888; }
.cert-val { font-weight:600; color:var(--charcoal); text-align:right; max-width:60%; }
.cert-grades-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:7px; margin:14px 0; }
.cert-grade-cell { background:var(--mist); border-radius:10px; padding:9px 8px; text-align:center; }
.cert-grade-cell .cg-label { font-size:10px; color:#aaa; }
.cert-grade-cell .cg-val { font-size:18px; font-weight:800; margin-top:3px; border-radius:6px; padding:2px 6px; display:inline-block; }
.cert-qr-section { display:flex; align-items:center; gap:16px; background:var(--mist); border-radius:14px; padding:14px; margin:14px 0; }
.cert-qr-info { flex:1; }
.cert-qr-info .qr-label { font-size:11px; color:#888; }
.cert-qr-info .qr-id { font-weight:700; font-size:14px; color:#0d3321; margin-top:2px; }
.cert-qr-info .qr-url { font-size:11px; color:#2d8a55; margin-top:4px; word-break:break-all; }
.cert-validity {
background:#d4edda; border-radius:12px; padding:12px 14px;
display:flex; align-items:center; gap:10px; margin:12px 0;
}
.cert-validity .cv-icon { font-size:22px; }
.cert-validity .cv-text { font-size:13px; color:#155724; font-weight:600; }
.cert-validity .cv-date { font-size:11px; color:#1a7a3d; margin-top:2px; }
.cert-print-btn {
width:100%; background:linear-gradient(135deg,#0d3321,#1a5c36); color:white;
border:none; border-radius:12px; padding:14px; font-size:14px; font-weight:700;
cursor:pointer; font-family:var(--font-body); margin-top:8px;
}
.cert-print-btn:hover { opacity:.88; }

/* Farmer submissions tab */
.ap-my-card {
margin:0 16px 12px; background:white; border-radius:14px; padding:15px;
box-shadow:var(--shadow-sm);
}
.ap-my-approved { border-left:4px solid #155724; }
.ap-my-rejected { border-left:4px solid #842029; background:#fffafa; }
.ap-my-pending  { border-left:4px solid #856404; }
.ap-rej-box { background:#f8d7da; border-radius:10px; padding:12px 13px; margin-top:10px; }
.ap-rej-box .rj-cat { font-size:11px; font-weight:800; color:#842029; text-transform:uppercase; letter-spacing:.5px; }
.ap-rej-box .rj-feed { font-size:12px; color:#5c1a1a; margin-top:6px; line-height:1.6; }
.ap-rej-box .rj-guide { font-size:11px; color:#842029; margin-top:8px; font-weight:700; }
.ap-qr-mini { display:flex; align-items:center; gap:10px; background:var(--mist); border-radius:10px; padding:10px 12px; margin-top:10px; }
.ap-qr-mini svg { border-radius:6px; border:2px solid #e0e0e0; flex-shrink:0; }
.ap-qr-mini-info .qm-id { font-size:12px; font-weight:700; color:#0d3321; }
.ap-qr-mini-info .qm-valid { font-size:10px; color:#aaa; margin-top:2px; }
.ap-qr-mini-info .qm-link { font-size:11px; color:#2d8a55; font-weight:600; cursor:pointer; margin-top:4px; text-decoration:underline; }

/* Submit produce tab */
.ap-submit-wrap { padding:16px; max-width:560px; margin:0 auto; }
.ap-submit-head { font-family:var(--font-head); font-size:22px; color:#0d3321; }
.ap-submit-sub  { font-size:13px; color:#888; margin-top:4px; margin-bottom:16px; }
.ap-form-card { background:white; border-radius:var(--radius); padding:16px; box-shadow:var(--shadow-sm); margin-bottom:13px; }
.ap-form-card h3 { font-size:13px; font-weight:700; color:#0d3321; margin-bottom:13px; }
.ap-form-row { display:flex; gap:10px; }

/* ══ LOGIN / AUTH ══ */
.login-wrap { position:fixed; inset:0; background:linear-gradient(135deg,#0d2218 0%,#1a3a2a 55%,#2d6a4f 100%); display:flex; align-items:center; justify-content:center; z-index:1000; padding:20px; }
.login-card { background:white; border-radius:24px; padding:28px 24px; width:100%; max-width:380px; box-shadow:0 20px 60px rgba(0,0,0,.35); animation:popIn .35s var(--spring); }
.login-logo { text-align:center; margin-bottom:20px; }
.login-logo img { width:70px; height:70px; border-radius:16px; object-fit:cover; }
.login-title { font-family:var(--font-head); font-size:22px; color:var(--forest); text-align:center; margin-top:8px; }
.login-sub   { font-size:12px; color:#aaa; text-align:center; margin-top:4px; margin-bottom:20px; }
.role-grid { display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-bottom:16px; }
.role-card {
border:2px solid var(--sand); border-radius:14px; padding:14px 10px; text-align:center;
cursor:pointer; transition:all .18s; background:white;
}
.role-card:hover { border-color:var(--mint); background:var(--mist); transform:translateY(-2px); }
.role-card.sel { border-color:var(--forest); background:var(--mist); }
.role-card .rc-icon { font-size:28px; }
.role-card .rc-label { font-size:12px; font-weight:700; color:var(--forest); margin-top:6px; }
.login-btn { width:100%; background:linear-gradient(135deg,var(--forest),var(--leaf)); color:white; border:none; border-radius:14px; padding:15px; font-size:14px; font-weight:700; cursor:pointer; font-family:var(--font-body); transition:opacity .18s; }
.login-btn:hover { opacity:.88; }
.login-btn:disabled { opacity:.4; cursor:not-allowed; }

/* ── OTP Auth flow ── */
.otp-stage-label { font-size:10px; font-weight:700; letter-spacing:.8px; text-transform:uppercase; color:#bbb; text-align:center; margin-bottom:16px; }
.otp-steps  { display:flex; justify-content:center; gap:6px; margin-bottom:20px; }
.otp-dot    { width:8px; height:8px; border-radius:50%; background:var(--sand); transition:background .25s; }
.otp-dot.active { background:var(--forest); }
.otp-field  { width:100%; border:2px solid var(--sand); border-radius:12px; padding:13px 14px; font-size:15px; font-family:var(--font-body); outline:none; box-sizing:border-box; transition:border-color .18s; margin-bottom:10px; }
.otp-field:focus { border-color:var(--leaf); }
.otp-field.error { border-color:#c0392b; }
.otp-code-wrap  { display:flex; gap:8px; margin-bottom:10px; }
.otp-code-digit { flex:1; border:2px solid var(--sand); border-radius:12px; padding:14px 0; font-size:20px; font-weight:700; text-align:center; font-family:var(--font-body); outline:none; transition:border-color .18s; }
.otp-code-digit.error { border-color:#c0392b; background:#fff5f5; }
.otp-code-digit:focus { border-color:var(--leaf); }
.skip-link { position:absolute; left:-999px; top:auto; width:1px; height:1px; overflow:hidden; }
.skip-link:focus { left:8px; top:8px; width:auto; height:auto; background:var(--forest); color:white; padding:8px 14px; border-radius:8px; font-size:12px; font-weight:700; z-index:9999; }
.success-bann { background:#d4edda; border-radius:12px; padding:12px 14px; font-size:13px; color:#155724; font-weight:600; display:flex; align-items:center; gap:8px; animation:slideDown .3s var(--spring); }
.otp-flag-wrap  { display:flex; align-items:center; border:2px solid var(--sand); border-radius:12px; padding:0 12px; margin-bottom:10px; overflow:hidden; transition:border-color .18s; }
.otp-flag-wrap:focus-within { border-color:var(--leaf); }
.otp-flag-wrap select { border:none; outline:none; background:transparent; font-size:13px; padding:12px 4px 12px 0; font-family:var(--font-body); cursor:pointer; }
.otp-flag-wrap input  { flex:1; border:none; outline:none; font-size:15px; padding:12px 0; font-family:var(--font-body); min-width:0; }
.otp-hint   { font-size:11px; color:#aaa; text-align:center; margin-bottom:14px; line-height:1.5; }
.otp-error  { font-size:12px; color:#c0392b; text-align:center; background:#fff0f0; border-radius:10px; padding:8px 12px; margin-bottom:10px; }
.otp-resend { background:none; border:none; color:var(--leaf); font-size:12px; font-weight:600; cursor:pointer; padding:4px 0; font-family:var(--font-body); }
.otp-resend:disabled { color:#bbb; cursor:not-allowed; }
.otp-back   { background:none; border:none; color:#888; font-size:12px; cursor:pointer; padding:4px 0; font-family:var(--font-body); display:flex; align-items:center; gap:4px; margin-bottom:12px; }
.otp-spinner { display:flex; align-items:center; justify-content:center; gap:8px; color:var(--forest); font-size:13px; font-weight:600; padding:8px 0; }
.otp-demo-pill { background:var(--mist); border-radius:10px; padding:8px 12px; font-size:11px; color:var(--bark); text-align:center; margin-bottom:14px; line-height:1.6; }
.otp-divider { display:flex; align-items:center; gap:8px; margin:12px 0; }
.otp-divider-line { flex:1; height:1px; background:var(--sand); }
.otp-divider-text { font-size:11px; color:#aaa; white-space:nowrap; }
.social-wrap { display:flex; flex-direction:column; gap:10px; margin-top:2px; }
.social-btn { width:100%; display:flex; align-items:center; justify-content:center; gap:10px; border:1.5px solid #dadce0; border-radius:14px; padding:13px 16px; font-size:13px; font-weight:600; cursor:pointer; background:white; font-family:var(--font-body); transition:all .18s; color:#3c4043; box-sizing:border-box; }
.social-btn:hover:not(:disabled) { background:#f8f9fa; border-color:#bbb; transform:translateY(-1px); box-shadow:0 2px 8px rgba(0,0,0,.08); }
.social-btn:disabled { opacity:.5; cursor:not-allowed; }
.social-btn.apple-btn { background:#000; color:#fff; border-color:#000; }
.social-btn.apple-btn:hover:not(:disabled) { background:#1a1a1a; transform:translateY(-1px); }
.social-google-wrap { width:100%; display:flex; justify-content:center; border-radius:14px; overflow:hidden; min-height:44px; }

/* ══ GDPR CONSENT ══ */
.consent-bd { position:fixed; inset:0; background:rgba(0,0,0,.7); z-index:900; display:flex; align-items:flex-end; justify-content:center; animation:fadeIn .2s; }
.consent-sheet { background:white; border-radius:24px 24px 0 0; width:100%; max-width:520px; padding:20px 20px 32px; animation:slideUp .35s var(--spring); max-height:80vh; overflow-y:auto; }
.consent-title { font-family:var(--font-head); font-size:20px; color:var(--forest); margin-bottom:8px; }
.consent-body  { font-size:13px; color:#555; line-height:1.7; }
.consent-items { margin:14px 0; display:flex; flex-direction:column; gap:8px; }
.consent-item  { display:flex; gap:10px; font-size:12px; color:#555; align-items:flex-start; }
.consent-item .ci { font-size:16px; flex-shrink:0; margin-top:1px; }
.consent-checks { display:flex; flex-direction:column; gap:8px; margin:14px 0; }
.consent-chk   { display:flex; align-items:flex-start; gap:10px; font-size:12px; color:#444; cursor:pointer; }
.consent-chk input { width:16px; height:16px; margin-top:1px; flex-shrink:0; accent-color:var(--forest); }
.consent-accept { width:100%; background:var(--forest); color:white; border:none; border-radius:12px; padding:14px; font-size:14px; font-weight:700; cursor:pointer; margin-top:10px; font-family:var(--font-body); transition:background .18s; }
.consent-accept:hover { background:var(--leaf); }
.consent-accept:disabled { opacity:.4; cursor:not-allowed; }
.consent-law { font-size:10px; color:#aaa; margin-top:8px; text-align:center; }

/* ══ ROLE BADGE in nav ══ */
.role-badge { display:flex; align-items:center; gap:4px; background:rgba(255,255,255,.15); border-radius:20px; padding:4px 10px; font-size:11px; color:white; font-weight:600; cursor:pointer; border:none; }
.role-badge:hover { background:rgba(255,255,255,.25); }

/* ══ NETWORK STATUS ══ */
.offline-banner { background:#c1440e; color:white; text-align:center; padding:6px; font-size:11px; font-weight:600; position:sticky; top:60px; z-index:99; }
/* SSE live indicator */
.sse-dot  { display:inline-block; width:7px; height:7px; border-radius:50%; background:#52b788; margin-right:4px; animation:ssePulse 2s ease-in-out infinite; vertical-align:middle; }
.sse-dot.off { background:#888; animation:none; }
@keyframes ssePulse { 0%,100%{opacity:1} 50%{opacity:.4} }

/* ── PWA install banner ── */
.pwa-banner { display:flex; align-items:center; gap:10px; padding:10px 16px; background:linear-gradient(135deg,#1a3a2a,#2d6a4f); color:white; position:sticky; top:60px; z-index:98; animation:slideDown .3s var(--spring); }
.pwa-banner-text { flex:1; font-size:12px; line-height:1.4; }
.pwa-banner-text strong { font-size:13px; display:block; margin-bottom:2px; }
.pwa-banner-install { background:white; color:var(--forest); border:none; border-radius:10px; padding:7px 14px; font-size:12px; font-weight:700; cursor:pointer; font-family:var(--font-body); white-space:nowrap; flex-shrink:0; }
.pwa-banner-dismiss { background:none; border:none; color:rgba(255,255,255,.6); font-size:18px; cursor:pointer; line-height:1; padding:0 0 0 4px; flex-shrink:0; }
.pwa-sw-badge { display:inline-flex; align-items:center; gap:4px; font-size:10px; color:rgba(255,255,255,.5); padding:2px 0; }
.pwa-sw-dot  { width:6px; height:6px; border-radius:50%; background:#27ae60; display:inline-block; }
.sync-banner    { background:var(--leaf); color:white; text-align:center; padding:5px; font-size:11px; font-weight:600; animation:slideDown .3s var(--spring); }

/* ══ COUPON INPUT ══ */
.coupon-row { display:flex; gap:7px; margin-top:8px; }
.coupon-input { flex:1; padding:9px 12px; border:1.5px solid var(--sand); border-radius:10px; font-size:13px; font-family:var(--font-body); outline:none; transition:border-color .17s; }
.coupon-input:focus { border-color:var(--mint); }
.coupon-btn { padding:9px 14px; background:var(--forest); color:white; border:none; border-radius:10px; font-size:12px; font-weight:700; cursor:pointer; font-family:var(--font-body); white-space:nowrap; }
.coupon-btn:hover { background:var(--leaf); }
.coupon-ok  { background:#d4edda; border-radius:8px; padding:8px 12px; font-size:12px; color:#155724; font-weight:600; display:flex; align-items:center; gap:6px; margin-top:6px; }
.coupon-err { background:#f8d7da; border-radius:8px; padding:8px 12px; font-size:12px; color:#721c24; font-weight:600; display:flex; align-items:center; gap:6px; margin-top:6px; }
.discount-line { display:flex; justify-content:space-between; font-size:12px; color:#155724; font-weight:600; margin-bottom:4px; }

/* ══ LOYALTY ══ */
.loyalty-bar { display:flex; align-items:center; gap:10px; background:linear-gradient(135deg,#5c3d1e,#e9a319); border-radius:12px; padding:12px 14px; color:white; margin-bottom:10px; }
.loyalty-icon { font-size:28px; }
.loyalty-pts  { font-family:var(--font-head); font-size:22px; color:var(--amber-text); } /* WCAG AA 8.1:1 */
.loyalty-tier { font-size:11px; opacity:.8; margin-top:2px; }
.loyalty-progress { height:5px; background:rgba(255,255,255,.3); border-radius:3px; margin-top:6px; }
.loyalty-fill { height:5px; background:white; border-radius:3px; transition:width .5s ease; }

/* ══ ANALYTICS DASHBOARD ══ */
.analytics-wrap { padding:0 0 24px; max-width:640px; margin:0 auto; }
.analytics-header { background:linear-gradient(135deg,#1a1a2e 0%,#16213e 55%,#0f3460 100%); padding:20px 18px 16px; }
.analytics-title { font-family:var(--font-head); font-size:22px; color:white; }
.analytics-sub   { font-size:12px; color:rgba(255,255,255,.6); margin-top:4px; }
.an-kpi-row { display:grid; grid-template-columns:repeat(2,1fr); gap:10px; padding:14px 16px; }
.an-kpi { background:white; border-radius:14px; padding:14px; box-shadow:var(--shadow-sm); }
.an-kpi-val { font-family:var(--font-head); font-size:26px; color:var(--forest); }
.an-kpi-lbl { font-size:11px; color:#aaa; margin-top:2px; text-transform:uppercase; letter-spacing:.4px; }
.an-kpi-delta { font-size:11px; color:var(--mint); font-weight:700; margin-top:4px; }
.an-section-title { font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.8px; color:var(--bark); padding:10px 16px 8px; }
.an-chart-wrap { padding:0 16px 8px; }
.an-bar-row { display:flex; align-items:center; gap:8px; margin-bottom:8px; }
.an-bar-label { font-size:11px; color:#888; width:30px; text-align:right; flex-shrink:0; }
.an-bar-track { flex:1; height:22px; background:#f5f5f5; border-radius:6px; overflow:hidden; position:relative; }
.an-bar-fill  { height:100%; border-radius:6px; display:flex; align-items:center; padding-left:8px; font-size:10px; font-weight:700; color:white; transition:width .6s ease; }
.an-bar-val   { position:absolute; right:8px; top:50%; transform:translateY(-50%); font-size:10px; font-weight:700; color:#555; }
.an-product-card { display:flex; gap:10px; padding:"10px 0"; border-bottom:1px solid var(--sand); align-items:center; }
.an-product-card:last-child { border-bottom:none; }
.an-donut-row { display:flex; align-items:center; justify-content:center; gap:24px; padding:10px 16px 16px; }
.an-donut-legend { display:flex; flex-direction:column; gap:8px; }
.an-legend-item { display:flex; align-items:center; gap:8px; font-size:13px; font-weight:600; color:var(--charcoal); }
.an-legend-dot  { width:12px; height:12px; border-radius:50%; flex-shrink:0; }
.an-rider-row   { display:flex; align-items:center; gap:10px; padding:9px 16px; border-bottom:1px solid var(--sand); }
.an-rider-row:last-child { border-bottom:none; }

/* ══ GEO CHECK-IN (Rider) ══ */
.geo-card { background:linear-gradient(135deg,#0c3547,#185a7d); border-radius:14px; padding:14px 16px; color:white; margin-bottom:14px; }
.geo-card-title { font-weight:700; font-size:14px; margin-bottom:8px; }
/* ── Route Optimisation ── */
.route-card      { background:linear-gradient(135deg,#1a3a2a,#2d6a4f); border-radius:16px; padding:15px 16px; margin-bottom:14px; color:white; }
.route-card-hd   { display:flex; align-items:center; justify-content:space-between; margin-bottom:10px; }
.route-card-title{ font-weight:700; font-size:14px; }
.route-badge     { background:var(--gold); color:var(--forest); border-radius:10px; padding:3px 9px; font-size:11px; font-weight:800; }
.route-stops     { display:flex; flex-direction:column; gap:7px; margin-bottom:12px; }
.route-stop      { display:flex; align-items:flex-start; gap:9px; background:rgba(255,255,255,.08); border-radius:10px; padding:9px 11px; }
.route-stop-num  { background:var(--gold); color:var(--forest); border-radius:50%; width:22px; height:22px; font-size:11px; font-weight:800; display:flex; align-items:center; justify-content:center; flex-shrink:0; margin-top:1px; }
.route-stop-info { flex:1; min-width:0; }
.route-stop-addr { font-size:12px; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.route-stop-meta { font-size:10px; color:rgba(255,255,255,.6); margin-top:2px; }
.route-nav-btn   { flex-shrink:0; background:white; color:var(--forest); border:none; border-radius:8px; padding:5px 10px; font-size:11px; font-weight:700; cursor:pointer; font-family:var(--font-body); }
.route-nav-btn:hover { background:var(--mint); }
.route-summary   { display:flex; gap:14px; background:rgba(255,255,255,.08); border-radius:10px; padding:9px 13px; }
.route-sum-item  { text-align:center; }
.route-sum-val   { font-family:var(--font-head); font-size:16px; color:var(--gold); }
.route-sum-lbl   { font-size:10px; color:rgba(255,255,255,.6); text-transform:uppercase; letter-spacing:.5px; }
.geo-coords { font-size:11px; opacity:.7; font-family:monospace; margin-top:4px; }
.geo-btn { background:rgba(255,255,255,.2); color:white; border:1.5px solid rgba(255,255,255,.4); border-radius:10px; padding:8px 16px; font-size:12px; font-weight:700; cursor:pointer; font-family:var(--font-body); transition:background .18s; }
.geo-btn:hover { background:rgba(255,255,255,.35); }
.geo-status-ok { background:rgba(82,183,136,.3); border-radius:8px; padding:6px 10px; font-size:11px; color:#52b788; font-weight:700; margin-top:8px; display:inline-flex; align-items:center; gap:5px; }

/* ══ UNIT TESTS PANEL ══ */
.tests-wrap { padding:16px; max-width:580px; margin:0 auto; }
.test-suite-title { font-family:var(--font-head); font-size:18px; color:var(--forest); margin-bottom:4px; }
.test-suite-sub   { font-size:12px; color:#aaa; margin-bottom:14px; }
.test-result { display:flex; align-items:flex-start; gap:8px; padding:8px 12px; border-radius:10px; margin-bottom:6px; }
.test-pass  { background:#d4edda; }
.test-fail  { background:#f8d7da; }
.test-name  { font-size:12px; font-weight:600; flex:1; }
.test-detail{ font-size:11px; color:#555; margin-top:2px; }

@media(max-width:480px){
/* Grid + shimmer: 2-column on narrow phones */
.grid,.tab-shimmer{grid-template-columns:repeat(2,1fr);gap:10px;padding:0 12px 20px}
/* Cart panel: full-width drawer on mobile */
.cart-panel{width:100vw;left:0;right:0}
/* Nav logo smaller on 320px */
.nav-logo{font-size:14px}
/* Currency conversion pills: 2-up */
.conv-grid{grid-template-columns:repeat(2,1fr)}
/* Express pay buttons: side-by-side */
.pay-express-row{grid-template-columns:1fr 1fr}
/* AgriPass stats: 2-column */
.ap-stats{grid-template-columns:repeat(2,1fr)}
/* Certificate grade grid: 2-column */
.cert-grades-grid{grid-template-columns:repeat(2,1fr)}
/* AgriPass inner tabs: smaller text */
.ap-tab{font-size:10px;padding:7px 2px}
/* AgriPass form: stack fields */
.ap-form-row{flex-direction:column}
/* Rider stats: 2-column */
.rider-stats{grid-template-columns:repeat(2,1fr)}
/* Analytics KPI: 2-column (already 2-col, ensures no overflow) */
.an-kpi-row{grid-template-columns:1fr 1fr}
/* Login role grid: 2-column */
.role-grid{grid-template-columns:1fr 1fr}
/* Payout summary: stack on very narrow screens */
.payout-summary{grid-template-columns:1fr}
/* Hub stats pills: wrap freely */
.hub-stats{grid-template-columns:repeat(2,1fr)}
}
@media(max-width:360px){
.grid,.tab-shimmer{grid-template-columns:1fr}
.bn-label{font-size:9px}
.ap-tab{font-size:9px;padding:6px 1px}
}

/* ── Farmer Onboarding wizard ─────────────────────────────────────────────── */
.ob-wrap{display:flex;flex-direction:column;min-height:100dvh;background:var(--mist);font-family:var(--font-body)}
.ob-header{display:flex;align-items:center;justify-content:space-between;padding:16px 20px;background:var(--forest);color:white;position:sticky;top:0;z-index:10}
.ob-header-brand{font-family:var(--font-head);font-size:16px;font-weight:800;letter-spacing:-.3px}
.ob-progress-label{font-size:12px;opacity:.8}
.ob-progress-track{height:4px;background:var(--sand)}
.ob-progress-fill{height:4px;background:var(--amber);transition:width .4s ease}
.ob-body{flex:1;padding:24px 20px 120px;max-width:520px;margin:0 auto;width:100%;box-sizing:border-box}
.ob-step-title{font-family:var(--font-head);font-size:22px;color:var(--forest);margin:0 0 6px}
.ob-step-sub{font-size:14px;color:#666;margin:0 0 20px;line-height:1.5}
.ob-welcome{text-align:center;padding-top:16px}
.ob-welcome-icon{font-size:64px;margin-bottom:12px}
.ob-step-checklist{text-align:left;background:white;border-radius:14px;padding:14px 18px;margin:20px 0;border:1px solid var(--sand)}
.ob-check-row{display:flex;align-items:center;gap:10px;padding:8px 0;font-size:14px;color:var(--text);border-bottom:1px solid var(--mist)}
.ob-check-row:last-child{border-bottom:none}
.ob-welcome-btn{margin-top:8px}
.ob-field{margin-bottom:18px}
.ob-field label{display:block;font-size:13px;font-weight:700;color:var(--text);margin-bottom:6px}
.ob-field input,.ob-field select{width:100%;padding:12px 14px;border:1.5px solid var(--sand);border-radius:10px;font-size:15px;font-family:var(--font-body);color:var(--text);background:white;outline:none;box-sizing:border-box;transition:border-color .15s}
.ob-field input:focus,.ob-field select:focus{border-color:var(--forest)}
.ob-err-input{border-color:#e53e3e !important}
.ob-field-err{font-size:12px;color:#e53e3e;margin-top:4px;font-weight:600}
.ob-field-hint{font-size:11px;color:#999;margin-top:4px}
.ob-size-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
.ob-size-card{padding:14px 10px;border:2px solid var(--sand);border-radius:12px;background:white;cursor:pointer;text-align:center;transition:all .15s}
.ob-size-card.selected{border-color:var(--forest);background:var(--mist)}
.ob-size-label{font-weight:700;font-size:14px;color:var(--text)}
.ob-size-sub{font-size:11px;color:#888;margin-top:3px}
.ob-location-set{display:flex;align-items:center;gap:12px;background:white;border:1.5px solid var(--leaf);border-radius:12px;padding:14px 16px;margin-bottom:16px}
.ob-location-icon{font-size:24px}
.ob-location-coords{font-size:13px;font-weight:700;color:var(--forest)}
.ob-location-sub{font-size:12px;color:#888;margin-top:2px}
.ob-location-reset{margin-left:auto;background:none;border:none;font-size:18px;color:#ccc;cursor:pointer;padding:4px}
.ob-skip-link{display:block;text-align:center;margin-top:16px;font-size:13px;color:#999;background:none;border:none;cursor:pointer;text-decoration:underline}
.ob-crop-grid{display:flex;flex-wrap:wrap;gap:8px}
.ob-crop-chip{padding:7px 13px;border:1.5px solid var(--sand);border-radius:20px;font-size:13px;background:white;color:var(--text);cursor:pointer;transition:all .13s}
.ob-crop-chip.selected{background:var(--forest);border-color:var(--forest);color:white;font-weight:600}
.ob-radio-group{display:flex;flex-direction:column;gap:8px}
.ob-radio-opt{display:flex;align-items:center;gap:10px;padding:11px 14px;border:1.5px solid var(--sand);border-radius:10px;background:white;cursor:pointer;font-size:14px}
.ob-radio-opt.selected{border-color:var(--forest);background:var(--mist);font-weight:600}
.ob-radio-opt input[type=radio]{accent-color:var(--forest)}
.ob-yn-row{display:flex;gap:10px}
.ob-yn-btn{flex:1;padding:13px;border:2px solid var(--sand);border-radius:12px;font-size:14px;font-weight:600;background:white;cursor:pointer;transition:all .15s}
.ob-yn-btn.selected{background:var(--forest);border-color:var(--forest);color:white}
.ob-input-row{display:flex;gap:10px;align-items:center}
.ob-input-row input{flex:1}
.ob-input-unit{font-size:13px;color:#888;white-space:nowrap}
.ob-payout-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.ob-payout-card{display:flex;flex-direction:column;align-items:center;gap:6px;padding:16px 10px;border:2px solid var(--sand);border-radius:12px;background:white;cursor:pointer;transition:all .15s}
.ob-payout-card.selected{border-color:var(--forest);background:var(--mist)}
.ob-payout-icon{font-size:22px}
.ob-payout-label{font-size:13px;font-weight:700;color:var(--text)}
.ob-bank-note{font-size:13px;color:#888;background:var(--mist);border-radius:10px;padding:12px 14px;margin-top:8px}
.ob-review-list{background:white;border-radius:14px;border:1px solid var(--sand);overflow:hidden}
.ob-review-row{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--mist)}
.ob-review-row:last-child{border-bottom:none}
.ob-review-label{font-size:12px;font-weight:700;color:#888;width:72px;flex-shrink:0}
.ob-review-value{font-size:13px;color:var(--text);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ob-review-edit{font-size:12px;color:var(--forest);background:none;border:none;cursor:pointer;font-weight:700;white-space:nowrap;text-decoration:underline;padding:0}
.ob-nav{position:fixed;bottom:0;left:0;right:0;background:white;border-top:1px solid var(--sand);padding:14px 20px;display:flex;gap:12px;z-index:20}
.ob-nav-next{flex:1}
.ob-btn-primary{background:var(--forest);color:white;border:none;border-radius:12px;padding:14px 28px;font-size:15px;font-weight:700;font-family:var(--font-body);cursor:pointer;transition:background .15s}
.ob-btn-primary:hover{background:var(--leaf)}
.ob-btn-primary:disabled{opacity:.5;cursor:not-allowed}
.ob-btn-secondary{width:100%;background:white;border:2px solid var(--forest);color:var(--forest);border-radius:12px;padding:13px;font-size:14px;font-weight:700;font-family:var(--font-body);cursor:pointer}
.ob-btn-ghost{background:none;border:2px solid var(--sand);color:var(--text);border-radius:12px;padding:13px 20px;font-size:14px;font-weight:700;font-family:var(--font-body);cursor:pointer}
.ob-status-wrap{min-height:100dvh;display:flex;align-items:center;justify-content:center;background:var(--mist);padding:24px}
.ob-status-card{background:white;border-radius:20px;border:2px solid var(--sand);padding:40px 28px;text-align:center;max-width:380px;width:100%}
.ob-status-icon{font-size:56px;margin-bottom:16px}
.ob-status-title{font-family:var(--font-head);font-size:22px;color:var(--forest);margin-bottom:10px}
.ob-status-sub{font-size:14px;color:#666;line-height:1.6}
.ob-status-hint{font-size:12px;color:#bbb;margin-top:16px}
.dark .ob-field input,.dark .ob-field select{background:var(--card);border-color:#444;color:var(--text)}
.dark .ob-size-card,.dark .ob-radio-opt,.dark .ob-yn-btn,.dark .ob-payout-card{background:var(--card);border-color:#444}
.dark .ob-review-list,.dark .ob-status-card,.dark .ob-step-checklist,.dark .ob-location-set{background:var(--card);border-color:#444}
.dark .ob-nav{background:var(--card);border-color:#444}
.dark .ob-crop-chip{background:var(--card);border-color:#444}

/* ── Push notifications opt-in ────────────────────────────────────────────── */
.push-banner{display:flex;align-items:center;gap:12px;background:var(--forest);color:#fff;padding:12px 16px;border-radius:0}
.push-banner-text{flex:1;font-size:13px;line-height:1.45}
.push-banner-text strong{display:block;margin-bottom:2px}
.push-allow-btn{flex-shrink:0;background:#fff;color:var(--forest);border:none;border-radius:8px;padding:8px 14px;font-size:13px;font-weight:700;font-family:var(--font-body);cursor:pointer}
.push-dismiss-btn{background:none;border:none;color:rgba(255,255,255,.6);font-size:20px;cursor:pointer;padding:0 4px;line-height:1}

/* ── Seasonal calendar ─────────────────────────────────────────────────────── */
.season-section{padding:0 16px 4px}
.season-title{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:#bbb;margin-bottom:10px}
.season-scroll{display:flex;gap:10px;overflow-x:auto;padding-bottom:8px;-webkit-overflow-scrolling:touch;scrollbar-width:none}
.season-scroll::-webkit-scrollbar{display:none}
.season-card{flex:0 0 140px;background:var(--card);border:1.5px solid var(--sand);border-radius:14px;padding:12px;cursor:default}
.season-card.peak{border-color:var(--leaf);background:linear-gradient(135deg,#f0faf4,#e6f7ed)}
.season-emoji{font-size:28px;margin-bottom:6px}
.season-crop{font-weight:700;font-size:13px;color:var(--text);margin-bottom:2px}
.season-loc{font-size:11px;color:#888;margin-bottom:6px}
.season-badge{display:inline-block;font-size:10px;font-weight:700;border-radius:5px;padding:2px 7px}
.season-badge.in-season{background:#d4edda;color:#1a5c36}
.season-badge.peak-season{background:var(--leaf);color:#fff}
.season-badge.upcoming{background:#fff3cd;color:#856404}
.dark .season-card{background:var(--card);border-color:#444}
.dark .season-card.peak{background:linear-gradient(135deg,#1a3a2a,#142d20)}

/* ── Farmer earnings dashboard ────────────────────────────────────────────── */
.earn-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:16px}
.earn-stat{background:var(--mist);border-radius:12px;padding:12px 14px}
.earn-stat-val{font-family:var(--font-head);font-size:20px;color:var(--forest)}
.earn-stat-lbl{font-size:11px;color:#888;margin-top:2px}
.earn-chart-wrap{margin-bottom:16px}
.earn-chart-title{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:#bbb;margin-bottom:8px}
.earn-bars{display:flex;align-items:flex-end;gap:6px;height:80px}
.earn-bar-col{display:flex;flex-direction:column;align-items:center;flex:1;gap:3px}
.earn-bar{width:100%;border-radius:4px 4px 0 0;min-height:4px;transition:height .4s ease}
.earn-bar.this-week{background:var(--forest)}
.earn-bar.last-week{background:var(--sand);opacity:.7}
.earn-bar-lbl{font-size:9px;color:#aaa;white-space:nowrap}
.earn-legend{display:flex;gap:12px;margin-top:6px}
.earn-leg-item{display:flex;align-items:center;gap:5px;font-size:11px;color:#888}
.earn-leg-dot{width:10px;height:10px;border-radius:2px}
.earn-top{margin-top:4px}
.earn-top-row{display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid var(--sand)}
.earn-top-row:last-child{border-bottom:none}
.earn-top-emoji{font-size:20px}
.earn-top-name{flex:1;font-size:13px;font-weight:600}
.earn-top-amt{font-size:13px;color:var(--forest);font-weight:700}

/* ── Referral system ──────────────────────────────────────────────────────── */
.ref-card{background:linear-gradient(135deg,var(--forest),var(--leaf));color:#fff;border-radius:16px;padding:20px;margin:0 16px 16px}
.ref-title{font-family:var(--font-head);font-size:18px;margin-bottom:4px}
.ref-sub{font-size:13px;opacity:.85;line-height:1.45;margin-bottom:14px}
.ref-code-row{display:flex;align-items:center;gap:10px;background:rgba(255,255,255,.15);border-radius:10px;padding:10px 14px;margin-bottom:14px}
.ref-code{font-family:var(--font-head);font-size:22px;letter-spacing:3px;flex:1}
.ref-copy-btn{background:#fff;color:var(--forest);border:none;border-radius:8px;padding:7px 14px;font-size:13px;font-weight:700;font-family:var(--font-body);cursor:pointer;white-space:nowrap}
.ref-share-btn{display:flex;align-items:center;gap:6px;background:#25D366;color:#fff;border:none;border-radius:10px;padding:10px 16px;font-size:14px;font-weight:700;font-family:var(--font-body);cursor:pointer;width:100%;justify-content:center}
.ref-stats{display:flex;gap:16px;margin-top:14px}
.ref-stat{text-align:center}
.ref-stat-val{font-family:var(--font-head);font-size:18px}
.ref-stat-lbl{font-size:10px;opacity:.75;margin-top:1px}
.ref-input-row{display:flex;gap:8px;margin-bottom:8px}
.ref-input{flex:1;padding:11px 14px;border-radius:10px;border:1.5px solid var(--sand);font-family:var(--font-body);font-size:14px;background:var(--card);color:var(--text)}
.ref-apply-btn{background:var(--forest);color:#fff;border:none;border-radius:10px;padding:11px 18px;font-size:14px;font-weight:700;font-family:var(--font-body);cursor:pointer}

/* ── Saved addresses ──────────────────────────────────────────────────────── */
.addr-list{display:flex;flex-direction:column;gap:10px;margin-bottom:12px}
.addr-card{display:flex;align-items:center;gap:12px;background:var(--card);border:1.5px solid var(--sand);border-radius:12px;padding:12px 14px;cursor:pointer}
.addr-card.selected{border-color:var(--forest);background:#f0faf4}
.addr-card.default-addr{border-color:var(--leaf)}
.addr-icon{font-size:22px;flex-shrink:0}
.addr-info{flex:1;min-width:0}
.addr-nick{font-weight:700;font-size:14px;color:var(--text)}
.addr-text{font-size:12px;color:#888;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.addr-default-badge{font-size:10px;font-weight:700;color:var(--leaf)}
.addr-del-btn{background:none;border:none;color:#ccc;font-size:18px;cursor:pointer;padding:0 4px;flex-shrink:0}
.addr-del-btn:hover{color:var(--tomato)}
.addr-add-btn{width:100%;background:none;border:2px dashed var(--sand);color:#888;border-radius:12px;padding:12px;font-size:14px;font-family:var(--font-body);cursor:pointer}
.addr-add-btn:hover{border-color:var(--forest);color:var(--forest)}
.addr-form{display:flex;flex-direction:column;gap:10px;background:var(--mist);border-radius:14px;padding:16px;margin-top:4px}
.dark .addr-card{background:var(--card);border-color:#444}
.dark .addr-form{background:var(--card)}

/* ── Video produce previews ───────────────────────────────────────────────── */
.modal-video-wrap{position:relative;width:100%;background:#000;border-radius:0;overflow:hidden;max-height:220px}
.modal-video{width:100%;max-height:220px;object-fit:cover;display:block}
.modal-video-badge{position:absolute;top:10px;left:10px;background:rgba(0,0,0,.6);color:#fff;font-size:10px;font-weight:700;border-radius:6px;padding:3px 8px;display:flex;align-items:center;gap:4px;pointer-events:none}
.card-video-pill{position:absolute;bottom:6px;right:6px;background:rgba(0,0,0,.6);color:#fff;font-size:9px;font-weight:700;border-radius:5px;padding:2px 7px;display:flex;align-items:center;gap:3px}

/* ── Price comparison widget ──────────────────────────────────────────────── */
.price-compare{display:flex;align-items:center;gap:8px;background:linear-gradient(135deg,#f0faf4,#e6f7ed);border:1.5px solid var(--leaf);border-radius:10px;padding:9px 12px;margin-top:10px}
.price-compare-save{font-weight:800;font-size:13px;color:var(--forest)}
.price-compare-vs{font-size:11px;color:#666;line-height:1.35}
.price-compare-icon{font-size:20px;flex-shrink:0}
.card-save-badge{position:absolute;top:6px;right:34px;background:var(--leaf);color:#fff;font-size:9px;font-weight:800;border-radius:5px;padding:2px 6px}

/* ── Chama group buying ───────────────────────────────────────────────────── */
.chama-btn{display:flex;align-items:center;gap:6px;background:var(--forest);color:#fff;border:none;border-radius:10px;padding:10px 16px;font-size:13px;font-weight:700;font-family:var(--font-body);cursor:pointer;width:100%;justify-content:center;margin-top:8px}
.chama-btn:hover{background:var(--leaf)}
.chama-overlay{position:fixed;inset:0;z-index:8800;background:rgba(0,0,0,.6);display:flex;align-items:flex-end;justify-content:center}
.chama-sheet{background:var(--card,#fff);border-radius:24px 24px 0 0;width:100%;max-width:540px;padding:24px 20px 40px;animation:slideUp .35s ease}
.chama-title{font-family:var(--font-head);font-size:20px;color:var(--forest);margin-bottom:6px}
.chama-sub{font-size:13px;color:#888;margin-bottom:16px;line-height:1.5}
.chama-link-box{display:flex;align-items:center;gap:8px;background:var(--mist);border-radius:10px;padding:10px 14px;margin-bottom:14px}
.chama-link-text{flex:1;font-size:12px;color:#555;word-break:break-all}
.chama-copy-btn{background:var(--forest);color:#fff;border:none;border-radius:8px;padding:7px 13px;font-size:12px;font-weight:700;font-family:var(--font-body);cursor:pointer;white-space:nowrap;flex-shrink:0}
.chama-member-list{margin-bottom:14px}
.chama-member{display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--sand)}
.chama-member:last-child{border-bottom:none}
.chama-member-av{font-size:20px}
.chama-member-name{flex:1;font-size:13px;font-weight:600}
.chama-member-items{font-size:12px;color:#888}
.chama-checkout-btn{width:100%;background:var(--forest);color:#fff;border:none;border-radius:14px;padding:14px;font-size:15px;font-weight:700;font-family:var(--font-body);cursor:pointer}
.chama-badge{position:absolute;top:-6px;right:-6px;background:var(--forest);color:#fff;font-size:9px;font-weight:800;border-radius:10px;padding:2px 6px;white-space:nowrap}

/* ── Stock alert (notify me) ──────────────────────────────────────────────── */
.notify-btn{width:100%;background:none;border:1.5px solid var(--forest);color:var(--forest);border-radius:10px;padding:9px;font-size:13px;font-weight:700;font-family:var(--font-body);cursor:pointer;margin-top:8px}
.notify-btn.active{background:var(--mist);border-color:var(--leaf);color:var(--leaf)}
.notify-pill{font-size:9px;font-weight:700;background:#fff3cd;color:#856404;border-radius:5px;padding:2px 6px;position:absolute;bottom:6px;left:6px}

/* ── Delivery ETA on card ─────────────────────────────────────────────────── */
.card-eta{font-size:10px;color:var(--leaf);font-weight:700;margin-top:3px}

/* ── Recently viewed ─────────────────────────────────────────────────────── */
.recent-section{padding:0 16px 4px}
.recent-title{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:#bbb;margin-bottom:8px}
.recent-scroll{display:flex;gap:10px;overflow-x:auto;padding-bottom:6px;scrollbar-width:none}
.recent-scroll::-webkit-scrollbar{display:none}
.recent-chip{flex:0 0 auto;background:var(--card);border:1.5px solid var(--sand);border-radius:12px;padding:8px 12px;display:flex;align-items:center;gap:8px;cursor:pointer}
.recent-chip:hover{border-color:var(--forest)}
.recent-chip-emoji{font-size:20px}
.recent-chip-name{font-size:12px;font-weight:600;color:var(--text)}
.recent-chip-price{font-size:11px;color:#888}

/* ── Receipt sharing ──────────────────────────────────────────────────────── */
.receipt-share-btn{display:flex;align-items:center;gap:6px;background:#25D366;color:#fff;border:none;border-radius:10px;padding:10px 16px;font-size:13px;font-weight:700;font-family:var(--font-body);cursor:pointer;width:100%;justify-content:center;margin-top:8px}

/* ── Farmer Tour ──────────────────────────────────────────────────────────── */
.ftour-overlay{position:fixed;inset:0;z-index:9000;background:rgba(0,0,0,.7);display:flex;align-items:flex-end;justify-content:center}
.ftour-sheet{background:var(--card,#fff);border-radius:24px 24px 0 0;width:100%;max-width:540px;padding:28px 24px 40px;animation:slideUp .35s ease}
.ftour-progress{display:flex;gap:6px;justify-content:center;margin-bottom:24px}
.ftour-dot{width:8px;height:8px;border-radius:50%;background:var(--sand,#e0e0e0);transition:background .2s}
.ftour-dot.active{background:var(--forest,#1a5c36);width:24px;border-radius:4px}
.ftour-emoji{font-size:52px;text-align:center;margin-bottom:12px}
.ftour-title{font-family:var(--font-head);font-size:22px;color:var(--forest,#1a5c36);text-align:center;margin-bottom:8px}
.ftour-desc{font-size:14px;color:#666;line-height:1.65;text-align:center;margin-bottom:24px}
.ftour-actions{display:flex;gap:12px}
.ftour-skip{flex:0 0 auto;background:none;border:2px solid var(--sand,#e0e0e0);color:#888;border-radius:12px;padding:13px 18px;font-size:13px;font-weight:700;font-family:var(--font-body);cursor:pointer}
.ftour-next{flex:1;background:var(--forest,#1a5c36);color:#fff;border:none;border-radius:12px;padding:14px;font-size:15px;font-weight:700;font-family:var(--font-body);cursor:pointer}
.ftour-next:hover{background:var(--leaf,#52b788)}

/* ── Live Tracking Map ────────────────────────────────────────────────────── */
.track-overlay{position:fixed;inset:0;z-index:8500;background:rgba(0,0,0,.6);display:flex;align-items:flex-end;justify-content:center}
.track-sheet{background:var(--card,#fff);border-radius:24px 24px 0 0;width:100%;max-width:540px;animation:slideUp .35s ease;overflow:hidden}
.track-header{display:flex;align-items:center;justify-content:space-between;padding:16px 20px 12px}
.track-header h3{font-family:var(--font-head);font-size:18px;color:var(--forest,#1a5c36);margin:0}
.track-close{background:none;border:none;font-size:22px;cursor:pointer;color:#aaa;padding:0}
.track-map-wrap{width:100%;height:260px;background:#e8f4ea;position:relative;overflow:hidden}
.track-map-canvas{width:100%;height:100%}
.track-demo-map{width:100%;height:100%;background:linear-gradient(135deg,#d4edda 0%,#c3e6cb 50%,#b8dacc 100%);position:relative;display:flex;align-items:center;justify-content:center}
.track-road-h{position:absolute;left:0;right:0;top:50%;height:6px;background:rgba(255,255,255,.7);transform:translateY(-50%)}
.track-road-v{position:absolute;top:0;bottom:0;left:45%;width:6px;background:rgba(255,255,255,.7)}
.track-rider-pin{position:absolute;font-size:28px;transform:translate(-50%,-50%);transition:left .8s ease,top .8s ease;filter:drop-shadow(0 2px 4px rgba(0,0,0,.4))}
.track-dest-pin{position:absolute;font-size:24px;transform:translate(-50%,-100%)}
.track-info{padding:14px 20px 24px}
.track-eta{font-family:var(--font-head);font-size:20px;color:var(--forest,#1a5c36);margin-bottom:4px}
.track-addr{font-size:13px;color:#888;margin-bottom:12px}
.track-rider-row{display:flex;align-items:center;gap:12px;background:var(--mist,#f8f9fa);border-radius:12px;padding:10px 14px}
.track-rider-av{font-size:28px}
.track-rider-name{font-weight:700;font-size:14px;color:var(--text)}
.track-rider-vehicle{font-size:12px;color:#888}
.track-call-btn{margin-left:auto;background:var(--forest,#1a5c36);color:#fff;border:none;border-radius:10px;padding:8px 16px;font-size:13px;font-weight:700;font-family:var(--font-body);cursor:pointer}

/* ── WhatsApp button ──────────────────────────────────────────────────────── */
.wa-btn{display:inline-flex;align-items:center;gap:5px;background:#25D366;color:#fff;border:none;border-radius:10px;padding:7px 13px;font-size:12px;font-weight:700;font-family:var(--font-body);cursor:pointer;text-decoration:none;white-space:nowrap}
.wa-btn:hover{background:#20ba58}
.wa-btn svg{flex-shrink:0}
.card-wa-row{padding:0 12px 10px;display:flex;justify-content:flex-end}

/* ── Voice input (VoiceMic) ───────────────────────────────────────────────── */
.voice-btn{background:none;border:none;cursor:pointer;padding:6px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#aaa;transition:color .2s,background .2s}
.voice-btn:hover{background:rgba(0,0,0,.06);color:var(--forest,#1a5c36)}
.voice-btn.listening{color:var(--tomato,#e63946);animation:voicePulse 1s ease infinite}
.voice-btn.unsupported{opacity:.3;cursor:not-allowed}
@keyframes voicePulse{0%,100%{transform:scale(1)}50%{transform:scale(1.25)}}

/* ── Wholesale pricing ────────────────────────────────────────────────────── */
.badge-bulk{position:absolute;bottom:6px;left:6px;background:#1a3a2a;color:#fff;font-size:9px;font-weight:800;border-radius:5px;padding:2px 6px;letter-spacing:.5px}
.wholesale-section{margin-top:14px}
.wholesale-label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:#bbb;margin-bottom:8px}
.wholesale-table{width:100%;border-collapse:collapse;font-size:13px}
.wholesale-table th{text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:#aaa;padding:4px 0;border-bottom:1px solid var(--sand,#e0e0e0)}
.wholesale-table td{padding:7px 0;border-bottom:1px solid var(--sand,#f0f0f0);color:var(--text)}
.wholesale-table tr:last-child td{border-bottom:none}
.wt-save{color:var(--leaf,#52b788);font-weight:700;font-size:12px}

/* ══════════ HerdPass styles ══════════ */
.herd-wrap{padding:0 0 90px}
.herd-loading{display:flex;flex-direction:column;align-items:center;justify-content:center;padding:60px 20px;gap:16px;color:#888}
.herd-loading span{font-size:64px}
.herd-header{display:flex;align-items:flex-start;justify-content:space-between;padding:16px 16px 8px;gap:12px}
.herd-title{font-size:22px;font-weight:800;color:var(--forest)}
.herd-subtitle{font-size:12px;color:#888;margin-top:2px;display:flex;align-items:center;gap:6px}
.herd-sync{font-size:10px;font-weight:700;padding:2px 6px;border-radius:5px;background:#f0f0f0;color:#888}
.herd-sync.ok{background:#e6f7ed;color:#2d6a4f}
.herd-sync.err{background:#fff0ee;color:#c62828}
.herd-add-btn{background:var(--forest);color:white;border:none;border-radius:10px;padding:9px 14px;font-size:13px;font-weight:700;cursor:pointer;white-space:nowrap;flex-shrink:0}
.herd-chips{display:flex;gap:8px;padding:4px 16px 12px;overflow-x:auto;-webkit-overflow-scrolling:touch;scrollbar-width:none}
.herd-chips::-webkit-scrollbar{display:none}
.herd-chip{background:var(--mist,#f5f5f5);border:1.5px solid transparent;border-radius:20px;padding:5px 12px;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap;color:var(--text,#222);transition:all .15s}
.herd-chip.active{background:var(--forest);color:white;border-color:var(--forest)}
.herd-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;padding:0 12px}
.herd-card{background:white;border-radius:14px;padding:12px;box-shadow:var(--shadow-sm,0 1px 6px rgba(0,0,0,.07));cursor:pointer;transition:transform .15s}
.herd-card:active{transform:scale(.97)}
.herd-card-top{display:flex;align-items:flex-start;gap:8px;margin-bottom:6px}
.herd-species-icon{font-size:28px;line-height:1;flex-shrink:0}
.herd-card-name{font-size:14px;font-weight:700;color:var(--forest);line-height:1.2;word-break:break-word}
.herd-card-tag{font-size:10px;color:#aaa;margin-top:2px}
.herd-status-dot{width:9px;height:9px;border-radius:50%;flex-shrink:0;margin-top:3px}
.herd-card-meta{font-size:11px;color:#888;margin-bottom:8px;line-height:1.4}
.herd-card-footer{display:flex;flex-wrap:wrap;gap:5px;align-items:center}
.herd-status-pill{font-size:10px;font-weight:700;border-radius:6px;padding:2px 7px}
.herd-last-ev{font-size:10px;color:#aaa;margin-left:auto}
.herd-lease-tag{font-size:10px;color:#8B7355;font-weight:700}
.herd-empty{display:flex;flex-direction:column;align-items:center;text-align:center;padding:48px 24px;gap:12px;color:#888}
.herd-empty h3{font-size:17px;font-weight:700;color:var(--text,#222)}
.herd-empty p{font-size:13px;line-height:1.5}
.herd-empty-sm{padding:20px 0;text-align:center;font-size:13px;color:#aaa}

/* Nav back bar */
.herd-nav-back{display:flex;align-items:center;justify-content:space-between;padding:10px 16px;border-bottom:1px solid var(--sand,#eee);background:white;position:sticky;top:0;z-index:10}
.herd-nav-back button{background:none;border:none;color:var(--forest);font-size:14px;font-weight:700;cursor:pointer;padding:4px 0}
.herd-nav-back span{font-size:14px;font-weight:700;color:var(--text)}
.herd-edit-btn{background:var(--mist,#f5f5f5);border:none;border-radius:8px;padding:6px 12px;font-size:12px;font-weight:700;cursor:pointer;color:var(--forest)}
.herd-del-btn{background:#fff0ee;border:none;border-radius:8px;padding:6px 12px;font-size:12px;font-weight:700;cursor:pointer;color:#c62828}

/* Detail hero */
.herd-detail-hero{background:var(--forest);color:white;padding:16px;display:flex;gap:14px;align-items:flex-start}
.herd-detail-name{font-size:20px;font-weight:800;line-height:1.2}

/* Stats row */
.herd-stats-row{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:var(--sand,#eee);border-bottom:1px solid var(--sand,#eee)}
.herd-stat{background:white;padding:10px 6px;text-align:center}
.herd-stat span{display:block;font-size:16px;font-weight:800;color:var(--forest)}
.herd-stat label{display:block;font-size:9px;text-transform:uppercase;letter-spacing:.6px;color:#aaa;margin-top:2px}

/* Section tabs */
.herd-sec-tabs{display:flex;overflow-x:auto;background:white;border-bottom:2px solid var(--sand,#eee);padding:0 12px;gap:2px;scrollbar-width:none}
.herd-sec-tabs::-webkit-scrollbar{display:none}
.herd-sec-tab{background:none;border:none;padding:10px 12px;font-size:13px;font-weight:600;color:#888;cursor:pointer;white-space:nowrap;border-bottom:2px solid transparent;margin-bottom:-2px}
.herd-sec-tab.active{color:var(--forest);border-bottom-color:var(--forest)}

/* Sections */
.herd-section{padding:12px 16px}
.herd-section-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;font-size:13px;font-weight:700;color:var(--text,#222)}
.herd-add-ev-btn{background:var(--mist,#f5f5f5);border:1.5px solid var(--leaf,#52b788);color:var(--forest);border-radius:8px;padding:5px 10px;font-size:11px;font-weight:700;cursor:pointer}
.herd-reminder-box{background:#fff9e6;border:1.5px solid #f5a623;border-radius:10px;padding:10px 14px;font-size:12px;color:#7a5c00;margin-bottom:12px}
.herd-repro-summary{background:#f0faf4;border:1.5px solid var(--leaf,#52b788);border-radius:10px;padding:12px 14px;font-size:13px;line-height:1.7;margin-bottom:12px;color:var(--forest)}

/* Timeline */
.herd-timeline{display:flex;flex-direction:column;gap:0}
.herd-ev-row{display:flex;gap:10px;align-items:flex-start;padding:10px 0;border-bottom:1px solid var(--sand,#f0f0f0)}
.herd-ev-row:last-child{border-bottom:none}
.herd-ev-dot{width:10px;height:10px;border-radius:50%;flex-shrink:0;margin-top:4px}
.herd-ev-body{flex:1;min-width:0}
.herd-ev-title{font-size:13px;font-weight:600;color:var(--text,#222)}
.herd-ev-meta{font-size:11px;color:#aaa;margin-top:2px}
.herd-ev-notes{font-size:12px;color:#666;margin-top:4px;font-style:italic}

/* Lease card */
.herd-lease-card{background:white;border-radius:14px;padding:14px;box-shadow:var(--shadow-sm,0 1px 6px rgba(0,0,0,.07));border:1.5px solid var(--sand,#eee)}
.herd-lease-header{display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:12px}
.herd-lease-lender{font-size:16px;font-weight:800;color:var(--forest)}
.herd-lease-dates{font-size:11px;color:#aaa;margin-top:2px}
.herd-progress-bar{height:8px;background:var(--sand,#eee);border-radius:4px;margin-bottom:12px;overflow:hidden}
.herd-progress-fill{height:100%;background:var(--leaf,#52b788);border-radius:4px;transition:width .4s}
.herd-lease-stats{display:grid;grid-template-columns:repeat(2,1fr);gap:8px 16px;font-size:12px}
.herd-lease-stats div{display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--sand,#f5f5f5);padding:4px 0}
.herd-lease-stats span{color:#888}
.herd-lease-done{background:#e6f7ed;color:#2d6a4f;font-weight:700;font-size:13px;border-radius:8px;padding:10px;text-align:center;margin-top:12px}

/* Form */
.herd-form{padding:16px;display:flex;flex-direction:column;gap:12px}
.herd-label{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.7px;color:#888;margin-bottom:-4px}
.herd-input{width:100%;background:var(--mist,#f5f5f5);border:1.5px solid transparent;border-radius:10px;padding:10px 12px;font-size:14px;font-family:var(--font-body,sans-serif);color:var(--text,#222);outline:none;transition:border-color .15s}
.herd-input:focus{border-color:var(--leaf,#52b788)}
.herd-species-row{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}
.herd-species-btn{background:var(--mist,#f5f5f5);border:1.5px solid transparent;border-radius:10px;padding:10px 4px;font-size:11px;font-weight:700;cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:4px;color:var(--text,#222);transition:all .15s}
.herd-species-btn .icon{font-size:24px}
.herd-species-btn.active{background:#e6f7ed;border-color:var(--leaf,#52b788);color:var(--forest)}
.herd-row{display:flex;flex-wrap:wrap;gap:6px}
.herd-2col{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.herd-save-btn{background:var(--forest);color:white;border:none;border-radius:12px;padding:14px;font-size:15px;font-weight:700;cursor:pointer;margin-top:4px;width:100%}
.herd-save-btn:disabled{opacity:.5;cursor:not-allowed}

/* Dark mode */
body.dark .herd-card{background:#1e2b22;color:white}
body.dark .herd-detail-hero{background:#0d2015}
body.dark .herd-stat{background:#1a2f20}
body.dark .herd-sec-tab{color:#aaa}
body.dark .herd-sec-tab.active{color:#52b788}
body.dark .herd-section-header{color:white}
body.dark .herd-ev-title{color:white}
body.dark .herd-form{background:transparent}
body.dark .herd-input{background:#1e2b22;color:white;border-color:#2d4a35}
body.dark .herd-lease-card{background:#1e2b22}
body.dark .herd-nav-back{background:#0d2015;border-color:#2d4a35}

/* Mobile: single column grid on very small screens */
@media(max-width:360px){.herd-grid{grid-template-columns:1fr}.herd-stats-row{grid-template-columns:repeat(2,1fr)}}

/* ══════════ AF Lease Application styles ══════════ */
.afl-wrap{min-height:100dvh;background:var(--bg,#fafaf8);padding-bottom:80px}
.afl-ref-wrap{min-height:100dvh;background:#f5faf7;padding-bottom:40px}
.afl-header{background:var(--forest);color:white;position:sticky;top:0;z-index:20;padding:10px 16px 0}
.afl-ref-header{background:var(--forest);color:white;padding:16px}
.afl-header-top{display:flex;align-items:center;gap:10px;margin-bottom:8px}
.afl-back{background:rgba(255,255,255,.2);border:none;color:white;width:34px;height:34px;border-radius:8px;font-size:18px;cursor:pointer;flex-shrink:0;display:flex;align-items:center;justify-content:center}
.afl-brand{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:rgba(255,255,255,.7)}
.afl-step-title{font-size:15px;font-weight:700;margin-top:2px}
.afl-counter{font-size:12px;font-weight:700;background:rgba(255,255,255,.2);padding:4px 8px;border-radius:6px;flex-shrink:0}
.afl-progress{display:flex;align-items:center;gap:4px;padding:8px 0 12px;overflow-x:auto;scrollbar-width:none}
.afl-progress::-webkit-scrollbar{display:none}
.afl-step-dot{background:rgba(255,255,255,.2);border:none;color:white;width:30px;height:30px;border-radius:50%;font-size:12px;cursor:pointer;flex-shrink:0;display:flex;align-items:center;justify-content:center;transition:all .15s}
.afl-step-dot.active{background:white;color:var(--forest);font-weight:700}
.afl-step-dot.done{background:rgba(255,255,255,.4);color:white}
.afl-body{padding:16px;display:flex;flex-direction:column;gap:12px}
.afl-section-title{font-size:13px;font-weight:800;text-transform:uppercase;letter-spacing:.7px;color:var(--forest);border-bottom:2px solid var(--leaf,#52b788);padding-bottom:4px;margin-top:4px}
.afl-check-row{display:flex;align-items:flex-start;gap:10px;font-size:13px;cursor:pointer;line-height:1.4}
.afl-check-row input{width:18px;height:18px;flex-shrink:0;margin-top:1px;accent-color:var(--forest)}
.afl-nav-btns{display:flex;gap:8px;margin-top:8px}
.afl-prev-btn{background:var(--mist,#f5f5f5);border:none;border-radius:10px;padding:12px 16px;font-size:14px;font-weight:700;cursor:pointer;color:var(--text,#222);flex-shrink:0}
.afl-add-row{background:none;border:1.5px dashed var(--leaf,#52b788);color:var(--forest);border-radius:8px;padding:8px 14px;font-size:12px;font-weight:700;cursor:pointer;width:100%;text-align:center}
.afl-machine-card{background:white;border-radius:12px;padding:14px;box-shadow:var(--shadow-sm,0 1px 6px rgba(0,0,0,.07));border:1.5px solid var(--sand,#eee);display:flex;flex-direction:column;gap:10px}
.afl-machine-no{font-size:12px;font-weight:800;text-transform:uppercase;color:var(--forest);letter-spacing:.6px}
.afl-cost-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:8px}
.afl-total-display{background:var(--mist,#f5f5f5);border-radius:8px;padding:10px 12px;font-size:14px;font-weight:700;color:var(--forest)}
.afl-grand-total{background:var(--forest);color:white;border-radius:10px;padding:12px 16px;font-size:15px;font-weight:800;text-align:center}
.afl-row-card{background:white;border-radius:10px;padding:12px;border:1.5px solid var(--sand,#eee);display:flex;flex-direction:column;gap:8px}
.afl-row-num{font-size:11px;font-weight:700;text-transform:uppercase;color:#aaa;letter-spacing:.6px}
.afl-declaration-box{background:#f0faf4;border:1.5px solid var(--leaf,#52b788);border-radius:10px;padding:14px;font-size:13px;line-height:1.6;color:var(--text,#333)}
.afl-summary{background:white;border-radius:12px;padding:14px;box-shadow:var(--shadow-sm,0 1px 6px rgba(0,0,0,.07));display:flex;flex-direction:column;gap:8px}
.afl-summary-row{display:flex;justify-content:space-between;align-items:center;font-size:13px;padding:5px 0;border-bottom:1px solid var(--sand,#f0f0f0)}
.afl-summary-row:last-child{border-bottom:none}
.afl-summary-row span{color:#888}
.afl-docs-note{background:#fff9e6;border:1.5px solid #f5a623;border-radius:8px;padding:10px 14px;font-size:12px;color:#7a5c00;line-height:1.5}
.afl-success{display:flex;flex-direction:column;align-items:center;padding:40px 24px;text-align:center;gap:12px}
.afl-success h2{font-size:22px;font-weight:800;color:var(--forest)}
.afl-success p{font-size:13px;color:#555;line-height:1.5}
.afl-referee-box{background:white;border-radius:12px;padding:16px;box-shadow:var(--shadow-sm,0 1px 6px rgba(0,0,0,.1));width:100%;max-width:420px}
.afl-referee-link{font-size:11px;color:#555;word-break:break-all;background:var(--mist,#f5f5f5);border-radius:6px;padding:8px;font-family:monospace;line-height:1.5}
.afl-copy-btn{background:var(--mist,#f5f5f5);border:none;border-radius:8px;padding:8px 14px;font-size:13px;font-weight:700;cursor:pointer}
.afl-wa-btn{background:#25D366;color:white;border-radius:8px;padding:8px 14px;font-size:13px;font-weight:700;text-decoration:none;display:inline-flex;align-items:center;gap:4px}
.afl-apply-btn{background:#1a5c36;color:white;border:none;border-radius:8px;padding:7px 12px;font-size:12px;font-weight:700;cursor:pointer;white-space:nowrap}

/* Dark mode AFL */
body.dark .afl-machine-card,body.dark .afl-row-card,body.dark .afl-summary,body.dark .afl-referee-box{background:#1e2b22}
body.dark .afl-body{background:transparent}
body.dark .afl-declaration-box{background:#0d2015}
body.dark .afl-total-display{background:#1e2b22;color:#52b788}
`;



// ─── useFocusTrap hook — WCAG 2.1 SC 2.1.2 keyboard focus containment ─────────────────
// Traps Tab/Shift+Tab inside a modal ref while isActive is true.
// Focuses the first focusable element on activation.
function useFocusTrap(ref, isActive) {
useEffect(() => {
if (!isActive || !ref.current) return;
const el = ref.current;
const FOCUSABLE = 'button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])';
const nodes  = Array.from(el.querySelectorAll(FOCUSABLE)).filter(n => !n.disabled);
const first  = nodes[0];
const last   = nodes[nodes.length - 1];
const onKey  = e => {
if (e.key !== "Tab") return;
if (e.shiftKey) {
if (document.activeElement === first) { e.preventDefault(); last?.focus(); }
} else {
if (document.activeElement === last)  { e.preventDefault(); first?.focus(); }
}
};
el.addEventListener("keydown", onKey);
setTimeout(() => first?.focus(), 50);
return () => el.removeEventListener("keydown", onKey);
}, [isActive, ref]);
}

// ─── Login screen — 3-stage OTP authentication ───────────────────────────────────────
// Stage 1: Phone entry with country dial-code picker
// Stage 2: 6-digit OTP verification (SMS via Africa's Talking in production)
// Stage 3: Role selection (demo mode only — production role comes from server JWT)
//
// Demo mode (API_BASE empty): any phone number works, code is always 123456.
// Production: set API_BASE → sendOTP calls Africa's Talking → verifyOTP returns JWT.

const DIAL_CODES = [
{ code:"TZ", flag:"🇹🇿", dial:"+255", label:"Tanzania (+255)"    },
{ code:"KE", flag:"🇰🇪", dial:"+254", label:"Kenya (+254)"       },
{ code:"UG", flag:"🇺🇬", dial:"+256", label:"Uganda (+256)"      },
{ code:"RW", flag:"🇷🇼", dial:"+250", label:"Rwanda (+250)"      },
{ code:"NG", flag:"🇳🇬", dial:"+234", label:"Nigeria (+234)"     },
{ code:"GH", flag:"🇬🇭", dial:"+233", label:"Ghana (+233)"       },
{ code:"ZA", flag:"🇿🇦", dial:"+27",  label:"South Africa (+27)" },
];

// Google logo SVG — inline so no external fetch needed
function SvgGoogle() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908C16.658 14.095 17.64 11.787 17.64 9.2Z"/>
      <path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18Z"/>
      <path fill="#FBBC05" d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332Z"/>
      <path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 6.29C4.672 4.163 6.656 3.58 9 3.58Z"/>
    </svg>
  );
}

function LoginScreen({ onLogin }) {
const [stage,        setStage]        = useState("phone");
const [dialCode,     setDialCode]     = useState("+255");
const [localNumber,  setLocalNumber]  = useState("");
const [otpDigits,    setOtpDigits]    = useState(["","","","","",""]);
const [selectedRole, setSelectedRole] = useState(null);
const [loading,      setLoading]      = useState(false);
const [error,        setError]        = useState("");
const [resendTimer,  setResendTimer]  = useState(0);
const [googleReady,  setGoogleReady]  = useState(false);
const [socialLoading,setSocialLoading]= useState(false);
const digitRefs   = [useRef(),useRef(),useRef(),useRef(),useRef(),useRef()];
const googleBtnRef = useRef(null);

const fullPhone = dialCode + localNumber.replace(/\D/g,"").slice(0,10);
const otpCode   = otpDigits.join("");

useEffect(() => {
if (resendTimer <= 0) return;
const t = setTimeout(() => setResendTimer(s => s - 1), 1000);
return () => clearTimeout(t);
}, [resendTimer]);

useEffect(() => {
if (stage === "otp") setTimeout(() => digitRefs[0].current?.focus(), 80);
}, [stage]); // eslint-disable-line

// ── Google Identity Services ─────────────────────────────────────────────────
const handleGoogleCredential = useCallback(async (response) => {
  setSocialLoading(true);
  setError("");
  try {
    if (!API_BASE) { setStage("role"); return; }
    const res = await apiService.loginWithGoogle(response.credential);
    if (res.success) {
      analytics.capture("auth.login_success", { method: "google" });
      apiService.fetchCsrfToken();
      if (res.role) onLogin(res.role);
      else setStage("role");
    } else {
      setError(res.error || "Google sign-in failed. Please try again.");
    }
  } catch { setError("Google sign-in failed. Please try again."); }
  finally { setSocialLoading(false); }
}, [onLogin]);

useEffect(() => {
  if (!GOOGLE_CLIENT_ID) return;
  const s = document.createElement("script");
  s.src = "https://accounts.google.com/gsi/client";
  s.async = true;
  s.onload = () => {
    window.google?.accounts.id.initialize({ client_id: GOOGLE_CLIENT_ID, callback: handleGoogleCredential });
    setGoogleReady(true);
  };
  document.head.appendChild(s);
  return () => { try { document.head.removeChild(s); } catch {} };
}, [handleGoogleCredential]);

// Render Google's button after the div is in the DOM and GIS is ready
useEffect(() => {
  if (!googleReady || !googleBtnRef.current) return;
  window.google?.accounts.id.renderButton(googleBtnRef.current, {
    theme: "outline", size: "large", shape: "rectangular",
    width: googleBtnRef.current.offsetWidth || 320,
    text: "continue_with", logo_alignment: "left",
  });
}, [googleReady]);

// ── Apple Sign In ─────────────────────────────────────────────────────────────
useEffect(() => {
  if (!APPLE_CLIENT_ID) return;
  const s = document.createElement("script");
  s.src = "https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js";
  s.async = true;
  s.onload = () => {
    window.AppleID?.auth.init({
      clientId: APPLE_CLIENT_ID,
      scope: "name email",
      redirectURI: window.location.origin,
      usePopup: true,
    });
  };
  document.head.appendChild(s);
  return () => { try { document.head.removeChild(s); } catch {} };
}, []);

const handleAppleSignIn = useCallback(async () => {
  setSocialLoading(true);
  setError("");
  try {
    if (!API_BASE) { setStage("role"); return; }
    const data = await window.AppleID.auth.signIn();
    const res = await apiService.loginWithApple(data.authorization.id_token, data.user || null);
    if (res.success) {
      analytics.capture("auth.login_success", { method: "apple" });
      apiService.fetchCsrfToken();
      if (res.role) onLogin(res.role);
      else setStage("role");
    } else {
      setError(res.error || "Apple sign-in failed. Please try again.");
    }
  } catch (err) {
    if (err?.error !== "popup_closed_by_user") {
      setError("Apple sign-in failed. Please try again.");
    }
  } finally { setSocialLoading(false); }
}, [onLogin]);

async function handleSendOTP() {
setError("");
if (localNumber.replace(/\D/g,"").length < 7) { setError("Please enter a valid mobile number."); return; }
setLoading(true);
try {
const res = await apiService.sendOTP(fullPhone, dialCode === "+255" ? "TZ" : "KE");
if (res.success) { setStage("otp"); setResendTimer(30); }
else setError(res.error || "Could not send OTP. Please try again.");
} catch { setError("Network error — please check your connection."); }
finally { setLoading(false); }
}

async function handleVerifyOTP() {
setError("");
if (otpCode.length < 6) { setError("Please enter all 6 digits."); return; }
setLoading(true);
try {
const res = await apiService.verifyOTP(fullPhone, otpCode);
if (res.success) {
tokenStore.set(res.token);
analytics.identify(res.userId || "demo-user", { phone: fullPhone });
analytics.capture("auth.login_success", { method: "otp" });
apiService.fetchCsrfToken(); // fetch + cache CSRF token for subsequent mutations
if (res.role) { onLogin(res.role); }
else          { setStage("role"); }
} else {
setError(res.error || "Incorrect code. Please try again.");
setOtpDigits(["","","","","",""]);
digitRefs[0].current?.focus();
}
} catch { setError("Network error — please check your connection."); }
finally { setLoading(false); }
}

function handleDigitInput(i, val) {
const d = val.replace(/\D/g,"").slice(-1);
const next = [...otpDigits]; next[i] = d; setOtpDigits(next);
if (d && i < 5) digitRefs[i+1].current?.focus();
if (!d && i > 0) digitRefs[i-1].current?.focus();
}

async function handleResend() {
setOtpDigits(["","","","","",""]); setError(""); setLoading(true);
try { await apiService.sendOTP(fullPhone, dialCode === "+255" ? "TZ" : "KE"); setResendTimer(30); }
catch { setError("Could not resend — please try again."); }
finally { setLoading(false); }
}

const stageIndex = { phone:0, otp:1, role:2 }[stage];

return (
<div className="login-wrap">
<div className="login-card">

    <div className="login-logo">
      <img src={LOGO_NAV} alt="Asiel Farms" style={{width:64,height:64,borderRadius:14,objectFit:"cover"}}/>
      <div className="login-title">Asiel Farm Shop</div>
    </div>

    {/* Step progress dots */}
    <div className="otp-steps">
      {[0,1,2].map(i => <div key={i} className={`otp-dot${i<=stageIndex?" active":""}`}/>)}
    </div>

    {/* ── Stage 1: Phone entry ── */}
    {stage === "phone" && <>
      <div className="login-sub" style={{marginBottom:14}}>Enter your mobile number to receive a one-time code</div>
      {!API_BASE && (
        <div className="otp-demo-pill">
          🧪 <strong>Demo mode</strong> — any number works<br/>Verification code is <strong>123456</strong>
        </div>
      )}
      <div className="otp-flag-wrap">
        <select value={dialCode} onChange={e => setDialCode(e.target.value)}>
          {DIAL_CODES.map(d => <option key={d.code} value={d.dial}>{d.flag} {d.dial}</option>)}
        </select>
        <input type="tel" placeholder="7XX XXX XXX"
          value={localNumber}
          onChange={e => setLocalNumber(e.target.value.replace(/\D/g,"").slice(0,10))}
          onKeyDown={e => e.key==="Enter" && handleSendOTP()}
          style={{flex:1,border:"none",outline:"none",fontSize:15,padding:"12px 0",fontFamily:"var(--font-body)",minWidth:0}}
        />
      </div>
      {error && <div className="otp-error">{error}</div>}
      <button className="login-btn" disabled={loading || localNumber.replace(/\D/g,"").length < 7} onClick={handleSendOTP}>
        {loading ? <span className="otp-spinner"><div className="spinner" style={{width:16,height:16,borderWidth:2,margin:0}}/>Sending...</span> : "Send Code →"}
      </button>
      <div className="otp-hint" style={{marginTop:10}}>🔒 One-time code via SMS · Africa's Talking</div>

      {/* ── Social sign-in ── */}
      <div className="otp-divider">
        <div className="otp-divider-line"/>
        <span className="otp-divider-text">or continue with</span>
        <div className="otp-divider-line"/>
      </div>
      <div className="social-wrap">
        {GOOGLE_CLIENT_ID
          ? <div ref={googleBtnRef} className="social-google-wrap"/>
          : <button className="social-btn" disabled={socialLoading}
              onClick={() => { setSocialLoading(true); setTimeout(() => { setSocialLoading(false); setStage("role"); }, 700); }}>
              <SvgGoogle/>
              <span>{!API_BASE ? "Continue with Google (Demo)" : "Continue with Google"}</span>
            </button>
        }
        <button className="social-btn apple-btn"
          disabled={socialLoading}
          onClick={APPLE_CLIENT_ID ? handleAppleSignIn : () => { setSocialLoading(true); setTimeout(() => { setSocialLoading(false); setStage("role"); }, 700); }}>
          <span style={{fontSize:17,lineHeight:1,fontFamily:"system-ui"}}>&#63743;</span>
          <span>{!API_BASE && !APPLE_CLIENT_ID ? "Continue with Apple (Demo)" : "Continue with Apple"}</span>
        </button>
      </div>
    </>}

    {/* ── Stage 2: OTP verification ── */}
    {stage === "otp" && <>
      <button className="otp-back" onClick={() => { setStage("phone"); setError(""); setOtpDigits(["","","","","",""]); }}>← Back</button>
      <div className="login-sub" style={{marginBottom:4}}>Code sent to <strong>{fullPhone}</strong></div>
      <div className="otp-hint">Enter the 6-digit code from your SMS</div>
      <div className="otp-code-wrap">
        {otpDigits.map((d,i) => (
          <input key={i} ref={digitRefs[i]}
            className={`otp-code-digit${error?" error":""}`}
            type="tel" inputMode="numeric" maxLength={1} value={d}
            onChange={e => handleDigitInput(i, e.target.value)}
            onKeyDown={e => { if(e.key==="Backspace"&&!d&&i>0) digitRefs[i-1].current?.focus(); }}
            onPaste={i===0 ? e => {
              const p=e.clipboardData.getData("text").replace(/\D/g,"").slice(0,6);
              if(p.length===6){ e.preventDefault(); setOtpDigits(p.split("")); digitRefs[5].current?.focus(); }
            } : undefined}
          />
        ))}
      </div>
      {error && <div className="otp-error">{error}</div>}
      <button className="login-btn" disabled={loading || otpCode.length<6} onClick={handleVerifyOTP}>
        {loading ? <span className="otp-spinner"><div className="spinner" style={{width:16,height:16,borderWidth:2,margin:0}}/>Verifying...</span> : "Verify & Continue →"}
      </button>
      <div style={{textAlign:"center",marginTop:10}}>
        <button className="otp-resend" disabled={resendTimer>0 || loading} onClick={handleResend}>
          {resendTimer>0 ? `Resend in ${resendTimer}s` : "Resend code"}
        </button>
      </div>
    </>}

    {/* ── Stage 3: Role selection (demo only) ── */}
    {stage === "role" && <>
      <div className="login-sub" style={{marginBottom:6}}>✅ Verified: <strong>{fullPhone}</strong></div>
      <div className="otp-demo-pill" style={{marginBottom:14}}>
        🧪 <strong>Demo mode</strong> — select your role<br/>
        In production your role is assigned by the server
      </div>
      <div className="role-grid">
        {Object.entries(ROLES).map(([id,r]) => (
          <div key={id} className={`role-card${selectedRole===id?" sel":""}`} onClick={() => setSelectedRole(id)}>
            <div className="rc-icon">{r.icon}</div>
            <div className="rc-label">{r.label}</div>
          </div>
        ))}
      </div>
      <button className="login-btn" disabled={!selectedRole} onClick={() => onLogin(selectedRole)}>
        {selectedRole ? `Continue as ${ROLES[selectedRole].label} ${ROLES[selectedRole].icon}` : "Select a role"}
      </button>
    </>}

    <div style={{fontSize:10,color:"#ccc",textAlign:"center",marginTop:12}}>
      🔒 Secured by Asiel Farm Shop · SMS · Google · Apple
    </div>
  </div>
</div>

);
}

// ─── Data consent dialog (Kenya DPA / GDPR) ─────────────────────────────────────────
function ConsentDialog({ onAccept }) {
const [checks, setChecks] = useState({ pii:false, processing:false, terms:false });
const allChecked = Object.values(checks).every(Boolean);
const toggle = k => setChecks(c => ({...c,[k]:!c[k]}));
return (
<div className="consent-bd">
<div className="consent-sheet">
<div className="consent-title">🔏 Data & Privacy Consent</div>
<div className="consent-body">
Before using Asiel Farm Shop, please review how we collect and use your information in compliance with the <strong>Kenya Data Protection Act 2019</strong>, <strong>Tanzania's Electronic and Postal Communications Act</strong>, and <strong>GDPR principles</strong>.
</div>
<div className="consent-items">
{[
["📋","Personal Information","We collect your name, phone number, farm location, and produce details to process orders and inspections."],
["📦","Order & Transaction Data","Purchase history, delivery routes, and payment references are stored locally on your device."],
["🌍","Location Data","Riders' GPS coordinates are used only during active deliveries and are not shared externally."],
["🔬","Inspection Records","AgriPass inspection results are linked to your farm identity and shared with hub managers."],
["🗑️","Your Rights","You may request data deletion at any time by contacting privacy@asfarm.tz"],
].map(([i,t,d]) => (
<div key={t} className="consent-item">
<span className="ci">{i}</span>
<div><strong style={{color:"#333"}}>{t}:</strong> {d}</div>
</div>
))}
</div>
<div className="consent-checks">
<label className="consent-chk"><input type="checkbox" checked={checks.pii} onChange={()=>toggle("pii")}/><span>I understand that my personal information (name, phone, location) will be collected and stored as described above.</span></label>
<label className="consent-chk"><input type="checkbox" checked={checks.processing} onChange={()=>toggle("processing")}/><span>I consent to my order, transaction, and inspection data being processed for the purpose of operating this platform.</span></label>
<label className="consent-chk"><input type="checkbox" checked={checks.terms} onChange={()=>toggle("terms")}/><span>I have read and agree to the <strong>Terms of Service</strong> and <strong>Privacy Policy</strong> of Asiel Farm Shop.</span></label>
</div>
<button className="consent-accept" disabled={!allChecked} onClick={onAccept}>
{allChecked ? "✅ I Accept — Continue to App" : "Please accept all terms to continue"}
</button>
<div className="consent-law">Kenya DPA 2019 · Tanzania EPOCA · GDPR Art. 6 · Last updated March 2026</div>
</div>
</div>
);
}

// ─── Analytics dashboard ────────────────────────────────────────────────────────────
function AnalyticsDashboard({ cur, country }) {
const [period, setPeriod] = useState("week");
const periodData   = ANALYTICS_DATA[period];
const d            = ANALYTICS_DATA;
const totalRevenue = periodData.totalRevenue;
const totalOrders  = periodData.totalOrders;
const maxRev       = Math.max(...periodData.daily.map(x => x.revenue));
const barColors    = ["#2d6a4f","#52b788","#e9a319","#c1440e","#0c5460","#5c3d1e","#2980b9"];
return (
<div className="analytics-wrap">
<div className="analytics-header">
<div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
<div>
<div className="analytics-title">📊 Sales Analytics</div>
<div className="analytics-sub">{getCfg(country).city} · {getCfg(country).name} · Live Dashboard</div>
</div>
<select value={period} onChange={e=>setPeriod(e.target.value)}
style={{background:"rgba(255,255,255,.15)",color:"white",border:"1px solid rgba(255,255,255,.3)",borderRadius:10,padding:"6px 10px",fontSize:12,fontFamily:"var(--font-body)",outline:"none"}}>
<option value="week">This Week</option>
<option value="month">This Month</option>
</select>
</div>
</div>

  {/* KPI cards */}
  <div className="an-kpi-row">
    {[
      ["TZS "+Math.round(totalRevenue/1000)+"K", "Total Revenue", periodData.deltaRev],
      [totalOrders, "Total Orders", periodData.deltaOrd],
      [d.topProducts.length, "Active Products", "Across 2 countries"],
      [d.riderPerf.reduce((s,r)=>s+r.delivered,0), "Deliveries Done", "↑ 9% completion rate"],
    ].map(([v,l,delta]) => (
      <div key={l} className="an-kpi">
        <div className="an-kpi-val">{v}</div>
        <div className="an-kpi-lbl">{l}</div>
        <div className="an-kpi-delta">{delta}</div>
      </div>
    ))}
  </div>

  {/* Daily revenue bar chart */}
  <div className="an-section-title">📈 {period === "week" ? "Daily" : "Weekly"} Revenue (TZS)</div>
  <div className="an-chart-wrap">
    {periodData.daily.map((day,i) => (
      <div key={day.day} className="an-bar-row">
        <div className="an-bar-label">{day.day}</div>
        <div className="an-bar-track">
          <div className="an-bar-fill" style={{width:`${(day.revenue/maxRev)*100}%`,background:barColors[i%barColors.length]}}>
            <span style={{fontSize:9}}>{day.orders} orders</span>
          </div>
          <div className="an-bar-val">{(day.revenue/1000).toFixed(0)}K</div>
        </div>
      </div>
    ))}
  </div>

  {/* Top products */}
  <div className="an-section-title">🥇 Top Products by Revenue</div>
  <div style={{background:"white",borderRadius:14,padding:"6px 16px 10px",margin:"0 16px",boxShadow:"var(--shadow-sm)"}}>
    {d.topProducts.map((p,i) => (
      <div key={p.name} style={{display:"flex",alignItems:"center",gap:10,padding:"9px 0",borderBottom:i<d.topProducts.length-1?"1px solid var(--sand)":"none"}}>
        <span style={{fontSize:22}}>{p.emoji}</span>
        <div style={{flex:1}}>
          <div style={{fontWeight:600,fontSize:13}}>{p.name}</div>
          <div style={{fontSize:11,color:"#aaa",marginTop:1}}>{p.orders} orders</div>
        </div>
        <div style={{textAlign:"right"}}>
          <div style={{fontWeight:700,fontSize:13,color:"var(--forest)"}}>TZS {(p.revenue/1000).toFixed(0)}K</div>
          <div style={{fontSize:10,color:"var(--mint)",fontWeight:600}}>#{i+1}</div>
        </div>
      </div>
    ))}
  </div>

  {/* Country split */}
  <div className="an-section-title">🌍 Revenue by Country</div>
  <div className="an-donut-row">
    <svg width={100} height={100} viewBox="0 0 36 36">
      <circle cx={18} cy={18} r={15.9} fill="none" stroke="#eee" strokeWidth="3.5"/>
      <circle cx={18} cy={18} r={15.9} fill="none" stroke="#2d6a4f" strokeWidth="3.5"
        strokeDasharray={`${d.countrySplit.TZ} ${100-d.countrySplit.TZ}`} strokeDashoffset="25" strokeLinecap="round"/>
      <circle cx={18} cy={18} r={15.9} fill="none" stroke="#e9a319" strokeWidth="3.5"
        strokeDasharray={`${d.countrySplit.KE} ${100-d.countrySplit.KE}`} strokeDashoffset={`${25-d.countrySplit.TZ}`} strokeLinecap="round"/>
      <text x={18} y={20} textAnchor="middle" style={{fontSize:5,fontWeight:800,fill:"#1a3a2a"}}>SPLIT</text>
    </svg>
    <div className="an-donut-legend">
      <div className="an-legend-item"><div className="an-legend-dot" style={{background:"#2d6a4f"}}/> 🇹🇿 Tanzania <strong>{d.countrySplit.TZ}%</strong></div>
      <div className="an-legend-item"><div className="an-legend-dot" style={{background:"#e9a319"}}/> 🇰🇪 Kenya <strong>{d.countrySplit.KE}%</strong></div>
    </div>
  </div>

  {/* Hub performance */}
  <div className="an-section-title">🏭 Hub Performance</div>
  <div style={{background:"white",borderRadius:14,padding:"6px 16px 10px",margin:"0 16px",boxShadow:"var(--shadow-sm)",marginBottom:12}}>
    {d.hubStats.map((h,i) => (
      <div key={h.hub} style={{padding:"10px 0",borderBottom:i<d.hubStats.length-1?"1px solid var(--sand)":"none"}}>
        <div style={{fontWeight:700,fontSize:13,marginBottom:8}}>{h.hub}</div>
        <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
          {[["📦",h.incoming,"Incoming"],["✅",h.greenlit,"Cleared"],["❌",h.rejected,"Rejected"],["🚴",h.transit,"In Transit"]].map(([ic,v,l])=>(
            <div key={l} style={{background:"var(--mist)",borderRadius:8,padding:"5px 10px",textAlign:"center",minWidth:60}}>
              <div style={{fontSize:14}}>{ic}</div>
              <div style={{fontWeight:800,fontSize:15,color:"var(--forest)"}}>{v}</div>
              <div style={{fontSize:10,color:"#aaa"}}>{l}</div>
            </div>
          ))}
        </div>
      </div>
    ))}
  </div>

  {/* Rider performance */}
  <div className="an-section-title">🚴 Rider Performance</div>
  <div style={{background:"white",borderRadius:14,margin:"0 16px 16px",boxShadow:"var(--shadow-sm)",overflow:"hidden"}}>
    {d.riderPerf.map((r,i) => (
      <div key={r.name} className="an-rider-row" style={{borderBottom:i<d.riderPerf.length-1?"1px solid var(--sand)":"none"}}>
        <div style={{width:34,height:34,borderRadius:"50%",background:"linear-gradient(135deg,var(--leaf),var(--mint))",display:"flex",alignItems:"center",justifyContent:"center",fontSize:16,flexShrink:0}}>🧑‍🦱</div>
        <div style={{flex:1}}>
          <div style={{fontWeight:600,fontSize:13}}>{r.name}</div>
          <div style={{fontSize:11,color:"#aaa"}}>⏱ Avg {r.avgTime} · ★ {r.rating}</div>
        </div>
        <div style={{fontFamily:"var(--font-head)",fontSize:20,color:"var(--forest)"}}>{r.delivered}</div>
        <div style={{fontSize:10,color:"#aaa",marginLeft:4}}>done</div>
      </div>
    ))}
  </div>
</div>

);
}

// ─── Unit test suite ────────────────────────────────────────────────────────────────
function UnitTestSuite() {
const [ran, setRan] = useState(false);
const [results, setResults] = useState([]);
const runTests = () => {
const tests = [
// fmt() tests
{ name:"fmt(7500,'TZS') → TZS7,500",    fn:()=>{ const r=fmt(7500,"TZS"); return r==="TZS7,500"?[true,r]:[false,`Got ${r}`]; }},
{ name:"fmt(7500,'USD') → $2.69",        fn:()=>{ const r=fmt(7500,"USD"); const ok=r.startsWith("$"); return [ok,r]; }},
{ name:"fmt(0,'TZS') → TZS0",            fn:()=>{ const r=fmt(0,"TZS"); return [r==="TZS0"||r==="TZS0.00"||r.includes("0"),r]; }},
// fmtCard() tests
{ name:"fmtCard('4111111111111111') → groups of 4", fn:()=>{ const r=fmtCard("4111111111111111"); const ok=r.split(" ").length===4; return [ok,r]; }},
{ name:"fmtCard('abc123') → strips letters",        fn:()=>{ const r=fmtCard("abc123"); const ok=!/[a-zA-Z]/.test(r); return [ok,r]; }},
// detectCard() tests
{ name:"detectCard('4111...') → visa",       fn:()=>{ const r=detectCard("4111111111111111"); return [r==="visa",r]; }},
{ name:"detectCard('5500...') → mastercard", fn:()=>{ const r=detectCard("5500000000000004"); return [r==="mastercard",r]; }},
{ name:"detectCard('3714...') → amex",       fn:()=>{ const r=detectCard("371449635398431"); return [r==="amex",r]; }},
{ name:"detectCard('hello') → null",         fn:()=>{ const r=detectCard("hello"); return [r===null,String(r)]; }},
// applyCoupon() tests
{ name:"applyCoupon('FRESH10', 20000) → 10% disc.", fn:()=>{ const r=applyCoupon("FRESH10",20000); return [r.valid&&r.discount===2000,JSON.stringify(r)]; }},
{ name:"applyCoupon('FRESH10', 5000) → min order fail", fn:()=>{ const r=applyCoupon("FRESH10",5000); return [!r.valid,r.error]; }},
{ name:"applyCoupon('INVALID', 20000) → invalid", fn:()=>{ const r=applyCoupon("INVALID",20000); return [!r.valid,r.error]; }},
{ name:"applyCoupon('fresh10', 20000) → case-insensitive", fn:()=>{ const r=applyCoupon("fresh10",20000); return [r.valid,String(r.valid)]; }},
// earnPoints() tests
{ name:"earnPoints(10000) → 100 pts",  fn:()=>{ const r=earnPoints(10000); return [r===100,String(r)]; }},
{ name:"earnPoints(250) → 2 pts",      fn:()=>{ const r=earnPoints(250); return [r===2,String(r)]; }},
// sanitiseQRInput() tests
{ name:"sanitiseQRInput('<script>') → stripped", fn:()=>{ const r=sanitiseQRInput("<script>alert(1)</script>"); const ok=!r.includes("<")&&!r.includes(">"); return [ok,r]; }},
{ name:"sanitiseQRInput('CERT-KE-001') → preserved", fn:()=>{ const r=sanitiseQRInput("CERT-KE-001"); return [r==="CERT-KE-001",r]; }},
// getLoyaltyTier() tests
{ name:"getLoyaltyTier(0) → Seedling",    fn:()=>{ const r=getLoyaltyTier(0); return [r.name==="Seedling",r.name]; }},
{ name:"getLoyaltyTier(1500) → Harvest",  fn:()=>{ const r=getLoyaltyTier(1500); return [r.name==="Harvest",r.name]; }},
{ name:"getLoyaltyTier(4000) → Gold Farmer",fn:()=>{ const r=getLoyaltyTier(4000); return [r.name==="Gold Farmer",r.name]; }},
// ── calcCommission() — money-critical, must match accountant figures ──
{ name:"calcCommission(168000,'TZ') commission=50400",
fn:()=>{ const r=calcCommission(168000,"TZ"); return [r.commissionAmt===50400,`comm=${r.commissionAmt}`]; }},
{ name:"calcCommission(168000,'TZ') vat=9072",
fn:()=>{ const r=calcCommission(168000,"TZ"); return [r.vatAmt===9072,`vat=${r.vatAmt}`]; }},
{ name:"calcCommission(168000,'TZ') netFarmer=116600",
fn:()=>{ const r=calcCommission(168000,"TZ"); return [r.netFarmer===116600,`net=${r.netFarmer}`]; }},
{ name:"calcCommission(55900,'KE') vatAmt=0 (KE no VAT)",
fn:()=>{ const r=calcCommission(55900,"KE"); return [r.vatAmt===0,`vat=${r.vatAmt}`]; }},
{ name:"calcCommission — netFarmer never negative",
fn:()=>{ const r=calcCommission(100,"TZ"); return [r.netFarmer>=0,`net=${r.netFarmer}`]; }},
// ── redeemValue() — 100 pts = TZS 2,000 ──
{ name:"redeemValue(100) → TZS 2000",
fn:()=>{ const r=redeemValue(100); return [r===2000,String(r)]; }},
{ name:"redeemValue(250) → TZS 4000 (floor to 100-pt buckets)",
fn:()=>{ const r=redeemValue(250); return [r===4000,String(r)]; }},
{ name:"redeemValue(50) → 0 (below threshold)",
fn:()=>{ const r=redeemValue(50); return [r===0,String(r)]; }},
// ── applyCoupon() edge cases ──
{ name:"applyCoupon('ORGANIC5K', 25000) → TZS 5000 fixed",
fn:()=>{ const r=applyCoupon("ORGANIC5K",25000); return [r.valid&&r.discount===5000,String(r.discount)]; }},
{ name:"applyCoupon('ASIEL20', 40000) → fails min order TZS 50,000",
fn:()=>{ const r=applyCoupon("ASIEL20",40000); return [!r.valid&&r.error.includes("50,000"),r.error||"no error"]; }},
// ── fmt() with CURRENCY_LOCALES ──
{ name:"fmt(10000,'KES') → starts with KSh",
fn:()=>{ const r=fmt(10000,"KES"); return [r.startsWith("KSh"),r]; }},
{ name:"fmt(null,'TZS') → doesn't throw",
fn:()=>{ try{ const r=fmt(null,"TZS"); return [true,r]; }catch(e){return [false,e.message];} }},
];
const out = tests.map(t => {
try { const [pass,detail]=t.fn(); return {name:t.name,pass,detail}; }
catch(e){ return {name:t.name,pass:false,detail:e.message}; }
});
setResults(out);
setRan(true);
};
// ── E2E test stubs (run with: npx playwright test) ──────────────────────────
// Add /tests/checkout.spec.ts using the Playwright scaffold in server.test.js
// Key flows to cover:
//   1. OTP login → add to cart → checkout → invoice download
//   2. AgriPass: submit produce → inspect → approve → view certificate
//   3. Rider: accept order → pickup → deliver → review prompt appears
//   4. Offline mode: add to cart offline → come back online → BackgroundSync fires
const passCount  = results.filter(r=>r.pass).length;
const failCount  = results.filter(r=>!r.pass).length;
return (
<div className="tests-wrap">
<div className="test-suite-title">🧪 Unit Test Suite</div>
<div className="test-suite-sub">Full coverage · {results.length} tests · fmt, fmtCard, detectCard, applyCoupon, earnPoints, sanitiseQRInput, getLoyaltyTier, calcCommission, redeemValue</div>
{ran && (
<div style={{display:"flex",gap:10,marginBottom:14,padding:"10px 12px",background:failCount===0?"#d4edda":"#fff3cd",borderRadius:12}}>
<div style={{fontWeight:700,fontSize:14,color:failCount===0?"#155724":"#856404"}}>
{failCount===0?"✅ All tests passed!":"⚠️ Some tests failed"} — {passCount}/{results.length} passed
</div>
</div>
)}
<button onClick={runTests} style={{width:"100%",background:"linear-gradient(135deg,#1a3a2a,#2d6a4f)",color:"white",border:"none",borderRadius:12,padding:13,fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:"var(--font-body)",marginBottom:14}}>
{ran?"🔄 Re-run Tests":"▶ Run All Tests"}
</button>
{results.map((r,i) => (
<div key={i} className={`test-result ${r.pass?"test-pass":"test-fail"}`}>
<span style={{fontSize:14}}>{r.pass?"✅":"❌"}</span>
<div>
<div className="test-name">{r.name}</div>
<div className="test-detail">{r.detail}</div>
</div>
</div>
))}
{!ran && <div style={{textAlign:"center",padding:"24px",color:"#aaa",fontSize:13}}>Press "Run All Tests" to execute the suite.</div>}
</div>
);
}

// ─── AgriPass component ─────────────────────────────────────────────────────────────
function AgriPass({ showToast, submissions, setSubmissions, country }) {
const { t } = useTranslation(); // AgriPass i18n
const [apTab, setApTab]           = useState("inspector");
// submissions & setSubmissions now come from App (lifted state) so they
// survive tab switches and are persisted to localStorage automatically.
// Filter by active country so TZ inspectors only see TZ batches and vice versa.
const visibleSubs = submissions.filter(s => !s.country || s.country === country);
const [search, setSearch]         = useState("");
const [statusFilter, setStatus]   = useState("all");
const [inspecting, setInspecting] = useState(null);   // submission being graded
const [certView, setCertView]     = useState(null);   // certificate being viewed
const [myName, setMyName]         = useState("");
const [decision, setDecision]     = useState(null);   // 'approve' | 'reject'
const [grades, setGrades]         = useState({});
const [remarks, setRemarks]       = useState("");
const [rejCat, setRejCat]         = useState("");
const [rejFeed, setRejFeed]       = useState("");
const [canResub, setCanResub]     = useState(true);
const [resDate, setResDate]       = useState("");
const [subForm, setSubForm]       = useState({ produce:"", submitter:"", role:"Farmer", origin:"", qty:"", unit:"KG", harvestDate:"", contact:"", notes:"" });
const apInspectRef = useRef(null); // focus trap for inspection modal
const apCertRef    = useRef(null); // focus trap for certificate modal
useFocusTrap(apInspectRef, !!inspecting);
useFocusTrap(apCertRef,    !!certView);
const [subPosted,    setSubPosted]   = useState(false);
const [subCooldown,  setSubCooldown]  = useState(false); // rate limit: 5s after submit

const allGraded = AP_CRITERIA.every(c => grades[c]);
const canSubmitInspection = allGraded && decision;

const stats = {
total:    visibleSubs.length,
approved: visibleSubs.filter(s=>s.status==="approved").length,
rejected: visibleSubs.filter(s=>s.status==="rejected").length,
pending:  visibleSubs.filter(s=>s.status==="pending").length,
};

const queueVisible = visibleSubs.filter(s => {
const q = search.toLowerCase();
const matchSearch = !q || s.produce.toLowerCase().includes(q) || s.submitter.toLowerCase().includes(q) || s.id.toLowerCase().includes(q);
const matchStatus = statusFilter === "all" || s.status === statusFilter;
return matchSearch && matchStatus;
});

const myVisible = visibleSubs.filter(s => {
if (!myName.trim()) return true;
return s.submitter.toLowerCase().includes(myName.toLowerCase());
});

const openInspect = (s) => {
setInspecting(s); setDecision(null); setGrades({}); setRemarks("");
setRejCat(""); setRejFeed(""); setCanResub(true); setResDate("");
};

const submitInspection = () => {
if (!canSubmitInspection) return;
const certId = decision === "approve" ? `CERT-${inspecting.id}-2026` : null;
const validUntil = decision === "approve" ? (() => {
const d = new Date(); d.setDate(d.getDate() + 14);
return d.toISOString().slice(0,10);
})() : null;
setSubmissions(prev => prev.map(s => s.id === inspecting.id ? {
...s, status: decision === "approve" ? "approved" : "rejected",
inspector: "Dr. Amani Mwita", grades, remarks, certId, validUntil,
rejectionInfo: decision === "reject" ? { category: rejCat, feedback: rejFeed, canResubmit: canResub, resubmitAfter: resDate } : null
} : s));
showToast(decision === "approve" ? t("ap.approved_toast") : t("ap.rejected_toast"));
setInspecting(null);
};

const submitProduce = () => {
if (subCooldown) { showToast(t("toast.wait")); return; }
if (!subForm.produce || !subForm.submitter || !subForm.origin) { showToast(t("ap.fill_required")); return; }
const newSub = {
id: `AP-${Date.now().toString().slice(-6)}`,
...subForm, qty: `${subForm.qty} ${subForm.unit}`,
country,
status:"pending", inspector:null, grades:{}, remarks:"", certId:null, validUntil:null, rejectionInfo:null,
submittedAt: new Date().toLocaleDateString("en-GB", {year:"numeric",month:"2-digit",day:"2-digit"}) + " " + new Date().toTimeString().slice(0,5)
};
setSubmissions(prev => [...prev, newSub]);
setSubPosted(true);
setSubCooldown(true);
setSubForm({ produce:"", submitter:"", role:"Farmer", origin:"", qty:"", unit:"KG", harvestDate:"", contact:"", notes:"" });
setTimeout(() => setSubPosted(false), 5000);
setTimeout(() => setSubCooldown(false), 5000); // 5s rate limit window
showToast(t("ap.submission_rx"));
setApTab("mine");
};

// Grade average helper for display
const gradeScore = { A:4, B:3, C:2, F:0 };
const avgGrade = (grades) => {
const vals = Object.values(grades).map(g => gradeScore[g] ?? 0);
if (!vals.length) return "—";
const avg = vals.reduce((a,b)=>a+b,0)/vals.length;
if (avg >= 3.5) return "A"; if (avg >= 2.5) return "B"; if (avg >= 1.5) return "C"; return "F";
};

return (
<div className="ap-wrap">
{/* ── HEADER ── */}
<div className="ap-header">
<div className="ap-brand">
<div className="ap-logo-ring">🔬</div>
<div>
<div className="ap-title">AgriPass</div>
<div className="ap-subtitle">Agricultural Produce Inspection System · 2026</div>
</div>
</div>
<div className="ap-tabs">
{[["inspector","🔍 Inspector"],["mine","👤 My Submissions"],["submit","📤 Submit Produce"]].map(([v,l]) => (
<button key={v} className={`ap-tab${apTab===v?" active":""}`} onClick={()=>setApTab(v)}>{l}</button>
))}
</div>
</div>

  {/* ── STATS BAR (inspector only) ── */}
  {apTab === "inspector" && (
    <div className="ap-stats">
      {[[stats.total,"blue","Total"],[stats.pending,"gold","Pending"],[stats.approved,"green","Approved"],[stats.rejected,"red","Rejected"]].map(([v,c,l])=>(
        <div key={l} className="ap-stat">
          <div className={`ap-stat-val ${c}`}>{v}</div>
          <div className="ap-stat-lbl">{l}</div>
        </div>
      ))}
    </div>
  )}

  {/* ══════════ INSPECTOR PANEL ══════════ */}
  {apTab === "inspector" && (
    <>
      <div className="ap-search-row">
        <div className="ap-search">
          <span>🔍</span>
          <input placeholder="Search produce, submitter, ID..." value={search} onChange={e=>setSearch(e.target.value)}/>
          {search && <button style={{background:"none",border:"none",cursor:"pointer",color:"#aaa",fontSize:13}} onClick={()=>setSearch("")}>✕</button>}
        </div>
        <select className="ap-filter" value={statusFilter} onChange={e=>setStatus(e.target.value)}>
          <option value="all">All</option>
          <option value="pending">Pending</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
        </select>
      </div>

      <div className="ap-sec">📋 Inspection Queue ({queueVisible.length})</div>

      {queueVisible.length === 0 && (
        <div style={{textAlign:"center",padding:"32px 20px",color:"#ccc"}}>
          <div style={{fontSize:44}}>🌿</div>
          <p style={{marginTop:10,fontSize:13}}>No submissions match your search.</p>
        </div>
      )}

      {queueVisible.map(s => (
        <div key={s.id} className={`ap-card ${s.status}`}>
          <div className="ap-card-top">
            <div>
              <div className="ap-card-id">{s.id} · {s.submittedAt}</div>
              <div className="ap-card-name">{s.produce}</div>
              <div className="ap-card-sub">🌱 {s.submitter} <span style={{color:"#aaa"}}>({s.role})</span></div>
            </div>
            <div className={`ap-status-pill ap-${s.status}`}>
              {s.status==="pending"?"⏳ Pending":s.status==="approved"?"✅ Approved":"❌ Rejected"}
            </div>
          </div>
          <div className="ap-card-meta">
            <span>📍 <strong>{s.origin}</strong></span>
            <span>⚖️ <strong>{s.qty}</strong></span>
            <span>🗓 <strong>{s.harvestDate}</strong></span>
            {s.inspector && <span>👤 <strong>{s.inspector}</strong></span>}
          </div>
          {s.grades && Object.keys(s.grades).length > 0 && (
            <div style={{display:"flex",gap:5,flexWrap:"wrap",marginTop:8}}>
              {Object.entries(s.grades).map(([k,v])=>(
                <span key={k} style={{background:GRADE_BG[v],color:GRADE_COLOR[v],borderRadius:6,padding:"2px 7px",fontSize:10,fontWeight:700}}>{k.slice(0,4)}: {v}</span>
              ))}
            </div>
          )}
          {s.status === "pending" && (
            <button className="ap-btn-inspect" onClick={()=>openInspect(s)}>🔍 Inspect & Grade</button>
          )}
          {s.status === "approved" && (
            <button className="ap-btn-cert" onClick={()=>setCertView(s)}>📄 View Certificate & QR</button>
          )}
          {s.status === "rejected" && s.rejectionInfo && (
            <div style={{background:"#f8d7da",borderRadius:10,padding:"10px 12px",marginTop:10,fontSize:12,color:"#5c1a1a"}}>
              <strong>Rejection:</strong> {s.rejectionInfo.category} — {s.rejectionInfo.feedback.slice(0,80)}...
            </div>
          )}
        </div>
      ))}
    </>
  )}

  {/* ══════════ MY SUBMISSIONS ══════════ */}
  {apTab === "mine" && (
    <>
      <div style={{padding:"14px 16px 8px"}}>
        <div className="ap-search">
          <span>👤</span>
          <input placeholder="Filter by your name or farm..." value={myName} onChange={e=>setMyName(e.target.value)}/>
        </div>
      </div>
      <div className="ap-sec">📋 Submissions ({myVisible.length})</div>
      {myVisible.map(s => (
        <div key={s.id} className={`ap-my-card ap-my-${s.status}`}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:8}}>
            <div>
              <div style={{fontSize:10,fontWeight:700,color:"#bbb",letterSpacing:.5}}>{s.id} · {s.submittedAt}</div>
              <div style={{fontWeight:700,fontSize:15,marginTop:2}}>{s.produce}</div>
              <div style={{fontSize:12,color:"var(--leaf)",marginTop:1}}>{s.submitter} · {s.origin}</div>
            </div>
            <div className={`ap-status-pill ap-${s.status}`}>
              {s.status==="pending"?"⏳ In Queue":s.status==="approved"?"✅ Approved":"❌ Rejected"}
            </div>
          </div>

          {s.status === "pending" && (
            <div style={{marginTop:10,fontSize:12,color:"#856404",background:"#fff3cd",borderRadius:8,padding:"8px 10px"}}>
              ⏳ Your submission is in the inspection queue. You'll be notified once graded.
            </div>
          )}

          {s.status === "approved" && (
            <>
              <div style={{display:"flex",gap:8,flexWrap:"wrap",marginTop:8}}>
                {Object.entries(s.grades).map(([k,v])=>(
                  <span key={k} style={{background:GRADE_BG[v],color:GRADE_COLOR[v],borderRadius:6,padding:"2px 7px",fontSize:10,fontWeight:700}}>{k.slice(0,4)}: {v}</span>
                ))}
              </div>
              <div style={{fontSize:12,color:"#555",marginTop:8,fontStyle:"italic"}}>"{s.remarks}"</div>
              <div className="ap-qr-mini">
                <QRCode data={s.certId+s.id+s.produce} size={63}/>
                <div className="ap-qr-mini-info">
                  <div className="qm-id">{s.certId}</div>
                  <div className="qm-valid">Valid until {s.validUntil} · Inspector: {s.inspector}</div>
                  <div className="qm-link" onClick={()=>setCertView(s)}>📄 View full certificate →</div>
                </div>
              </div>
            </>
          )}

          {s.status === "rejected" && s.rejectionInfo && (
            <div className="ap-rej-box">
              <div className="rj-cat">❌ Rejection Reason: {s.rejectionInfo.category}</div>
              <div className="rj-feed">{s.rejectionInfo.feedback}</div>
              {s.rejectionInfo.canResubmit
                ? <div className="rj-guide">🔄 You may resubmit after: {s.rejectionInfo.resubmitAfter}</div>
                : <div className="rj-guide" style={{color:"#842029"}}>🚫 This batch is not eligible for resubmission.</div>
              }
            </div>
          )}
        </div>
      ))}
      {myVisible.length === 0 && (
        <div style={{textAlign:"center",padding:"32px 20px",color:"#ccc"}}>
          <div style={{fontSize:44}}>📭</div>
          <p style={{marginTop:10,fontSize:13}}>No submissions found. Try a different name or submit your first batch.</p>
        </div>
      )}
    </>
  )}

  {/* ══════════ SUBMIT PRODUCE ══════════ */}
  {apTab === "submit" && (
    <div className="ap-submit-wrap">
      <div className="ap-submit-head">Submit for Inspection 📤</div>
      <div className="ap-submit-sub">Farmers and shop owners — submit produce batches for official AgriPass grading.</div>
      {subPosted && <div className="success-bann" style={{marginBottom:14}}>✅ Submission received! Your produce has been added to the inspection queue.</div>}
      <div className="ap-form-card">
        <h3>📦 Produce Details</h3>
        <div className="ap-field"><label>Produce Name *</label><input placeholder="e.g. Hass Avocados" value={subForm.produce} onChange={e=>setSubForm(f=>({...f,produce:e.target.value}))}/></div>
        <div className="ap-form-row">
          <div className="ap-field" style={{flex:2}}><label>Quantity *</label><input type="number" placeholder="Amount" value={subForm.qty} onChange={e=>setSubForm(f=>({...f,qty:e.target.value}))}/></div>
          <div className="ap-field" style={{flex:1}}><label>Unit</label><select value={subForm.unit} onChange={e=>setSubForm(f=>({...f,unit:e.target.value}))}><option>KG</option><option>Bunch</option><option>Crate</option><option>Piece</option></select></div>
        </div>
        <div className="ap-field"><label>Harvest Date *</label><input type="date" value={subForm.harvestDate} onChange={e=>setSubForm(f=>({...f,harvestDate:e.target.value}))}/></div>
        <div className="ap-field"><label>Farm / Origin *</label><input placeholder="e.g. Kilifi County, Kenya" value={subForm.origin} onChange={e=>setSubForm(f=>({...f,origin:e.target.value}))}/></div>
      </div>
      <div className="ap-form-card">
        <h3>👤 Submitter Info</h3>
        <div className="ap-field"><label>Your Name / Organisation *</label><input placeholder="e.g. Mama Zawadi or Kilimanjaro Fresh Ltd" value={subForm.submitter} onChange={e=>setSubForm(f=>({...f,submitter:e.target.value}))}/></div>
        <div className="ap-form-row">
          <div className="ap-field" style={{flex:1}}><label>Role</label><select value={subForm.role} onChange={e=>setSubForm(f=>({...f,role:e.target.value}))}><option>Farmer</option><option>Shop Owner</option><option>Aggregator</option></select></div>
          <div className="ap-field" style={{flex:2}}><label>Contact (Phone)</label><input type="tel" placeholder="+255 7XX XXX XXX" value={subForm.contact} onChange={e=>setSubForm(f=>({...f,contact:e.target.value}))}/></div>
        </div>
        <div className="ap-field"><label>Handling & Storage Notes</label><textarea placeholder="e.g. Stored in cool shade, harvested early morning, packed in ventilated crates..." value={subForm.notes} onChange={e=>setSubForm(f=>({...f,notes:e.target.value}))}/></div>
      </div>
      <div style={{background:"#e8f5e9",borderRadius:12,padding:"10px 13px",marginBottom:13,fontSize:12,borderLeft:"3px solid #2d8a55",color:"#1a5c36"}}>
        ℹ️ Submissions are reviewed within <strong>24--48 hours</strong>. Approved batches receive a QR-linked AgriPass certificate valid for <strong>14 days</strong>. You will be notified by SMS/WhatsApp on your contact number.
      </div>
      <button className="ap-submit-btn" onClick={submitProduce}
        disabled={subCooldown}
        style={subCooldown ? {opacity:0.55, cursor:"not-allowed"} : {}}>
        {subCooldown ? "⏳ Please wait..." : t("ap.submit_btn")}
      </button>
    </div>
  )}

  {/* ══════════ INSPECTION MODAL ══════════ */}
  {inspecting && (
    <div className="ap-modal-bd" role="dialog" aria-modal="true" aria-label="Inspection grading" onClick={e=>e.target===e.currentTarget&&setInspecting(null)}>
      <div className="ap-modal" ref={apInspectRef}>
        <div className="ap-modal-handle"/>
        <div className="ap-modal-head">
          <div className="ap-modal-title">🔍 Grading: {inspecting.produce}</div>
          <button className="ap-modal-close" onClick={()=>setInspecting(null)}>✕</button>
        </div>
        <div className="ap-modal-body">
          <div style={{background:"var(--mist)",borderRadius:12,padding:"10px 12px",marginBottom:14,fontSize:12,color:"var(--bark)"}}>
            <strong>{inspecting.submitter}</strong> ({inspecting.role}) · {inspecting.origin} · {inspecting.qty} · Harvested {inspecting.harvestDate}
            {inspecting.notes && <><br/><em style={{color:"#888"}}>Notes: {inspecting.notes}</em></>}
          </div>

          <div style={{fontWeight:700,fontSize:12,color:"#0d3321",marginBottom:10,textTransform:"uppercase",letterSpacing:.5}}>📊 Grade Each Criterion</div>

          {AP_CRITERIA.map(crit => (
            <div key={crit} className="ap-grade-row">
              <div className="ap-grade-label">{crit}</div>
              <div className="ap-grade-btns">
                {AP_GRADES.map(g => (
                  <button key={g} data-g={g}
                    className={`ap-grade-btn${grades[crit]===g?" selected":""}`}
                    style={grades[crit]===g?{background:GRADE_COLOR[g]}:{}}
                    onClick={()=>setGrades(prev=>({...prev,[crit]:g}))}>
                    {g}
                  </button>
                ))}
              </div>
            </div>
          ))}

          <div className="ap-field" style={{marginTop:6}}>
            <label>Inspector Remarks</label>
            <textarea placeholder="Overall observations about this batch..." value={remarks} onChange={e=>setRemarks(e.target.value)}/>
          </div>

          <div style={{fontWeight:700,fontSize:12,color:"#0d3321",margin:"14px 0 8px",textTransform:"uppercase",letterSpacing:.5}}>🏛 Decision</div>
          <div className="ap-decision">
            <button className={`ap-decision-btn approve${decision==="approve"?" sel":""}`} onClick={()=>setDecision("approve")}>✅ Approve</button>
            <button className={`ap-decision-btn reject${decision==="reject"?" sel":""}`}  onClick={()=>setDecision("reject")}>❌ Reject</button>
          </div>

          {decision === "reject" && (
            <div className="ap-rejection-form">
              <div style={{fontWeight:700,fontSize:12,color:"#842029",marginBottom:10}}>📋 Rejection Details (sent to farmer/shop owner)</div>
              <div className="ap-field">
                <label>Rejection Category *</label>
                <select value={rejCat} onChange={e=>setRejCat(e.target.value)}>
                  <option value="">— Select category —</option>
                  {["Pest & Disease Contamination","Freshness / Decay","Below Minimum Grade","Packaging Non-Compliance","Incorrect Documentation","Other"].map(c=>(
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </div>
              <div className="ap-field">
                <label>Detailed Feedback to Submitter *</label>
                <textarea placeholder="Describe specific issues found, guidance for improvement, and any actions required before resubmission..." value={rejFeed} onChange={e=>setRejFeed(e.target.value)}/>
              </div>
              <div style={{display:"flex",gap:12,alignItems:"center",marginTop:6}}>
                <label style={{fontSize:12,display:"flex",alignItems:"center",gap:6,cursor:"pointer"}}>
                  <input type="checkbox" checked={canResub} onChange={e=>setCanResub(e.target.checked)}/>
                  Allow resubmission
                </label>
                {canResub && (
                  <div style={{flex:1}}>
                    <input type="date" value={resDate} onChange={e=>setResDate(e.target.value)}
                      style={{width:"100%",padding:"7px 10px",border:"1.5px solid var(--sand)",borderRadius:8,fontFamily:"var(--font-body)",fontSize:12,outline:"none"}}
                      placeholder="Earliest resubmit date"/>
                  </div>
                )}
              </div>
            </div>
          )}

          <button className="ap-submit-btn" disabled={!canSubmitInspection} onClick={submitInspection}
            style={{marginTop:12,marginBottom:8}}>
            {decision==="approve"?"✅ Issue Certificate":"❌ Submit Rejection"}
          </button>
        </div>
      </div>
    </div>
  )}

  {/* ══════════ CERTIFICATE MODAL ══════════ */}
  {certView && (
    <div className="cert-modal-bd" role="dialog" aria-modal="true" aria-label="AgriPass certificate" onClick={e=>e.target===e.currentTarget&&setCertView(null)}>
      <div className="cert-sheet" ref={apCertRef}>
        <div className="ap-modal-handle"/>
        <div className="cert-header">
          <div className="cert-stamp">🌿</div>
          <div style={{flex:1}}>
            <div className="cert-title">AgriPass Certificate</div>
            <div className="cert-id">{certView.certId} · Issued by Asiel Farm Shop</div>
          </div>
          <button className="cert-close" onClick={()=>setCertView(null)}>✕</button>
        </div>

        <div className="cert-body">
          {/* Produce info */}
          <div style={{fontWeight:700,fontSize:11,textTransform:"uppercase",letterSpacing:.8,color:"#aaa",margin:"14px 0 8px"}}>🌾 Produce Information</div>
          {[["Produce",certView.produce],["Submitter",`${certView.submitter} (${certView.role})`],["Origin",certView.origin],["Quantity",certView.qty],["Harvest Date",certView.harvestDate],["Inspector",certView.inspector],["Overall Grade",avgGrade(certView.grades)]].map(([k,v])=>(
            <div key={k} className="cert-row"><span className="cert-key">{k}</span><span className="cert-val">{v}</span></div>
          ))}

          {/* Grades grid */}
          <div style={{fontWeight:700,fontSize:11,textTransform:"uppercase",letterSpacing:.8,color:"#aaa",margin:"14px 0 8px"}}>📊 Inspection Grades</div>
          <div className="cert-grades-grid">
            {Object.entries(certView.grades).map(([k,v])=>(
              <div key={k} className="cert-grade-cell">
                <div className="cg-label">{k}</div>
                <div className="cg-val" style={{background:GRADE_BG[v],color:GRADE_COLOR[v]}}>{v}</div>
              </div>
            ))}
          </div>

          {certView.remarks && (
            <div style={{background:"var(--mist)",borderRadius:10,padding:"10px 13px",fontSize:12,color:"var(--bark)",fontStyle:"italic",margin:"10px 0"}}>
              "{certView.remarks}"
            </div>
          )}

          {/* Validity */}
          <div className="cert-validity">
            <div className="cv-icon">✅</div>
            <div>
              <div className="cv-text">Approved for Market Entry</div>
              <div className="cv-date">Valid until {certView.validUntil} · AgriPass Certified</div>
            </div>
          </div>

          {/* QR Code */}
          <div style={{fontWeight:700,fontSize:11,textTransform:"uppercase",letterSpacing:.8,color:"#aaa",margin:"14px 0 8px"}}>📱 Traceability QR Code</div>
          <div className="cert-qr-section">
            <QRCode data={certView.certId+certView.id+certView.produce+certView.submitter} size={84}/>
            <div className="cert-qr-info">
              <div className="qr-label">Certificate ID</div>
              <div className="qr-id">{certView.certId}</div>
              <div className="qr-label" style={{marginTop:6}}>Verification URL</div>
              <div className="qr-url">https://agripass.asfarm.tz/verify/{certView.certId}</div>
              <div style={{fontSize:10,color:"#aaa",marginTop:6}}>Scan to verify authenticity, view full inspection report and farm origin.</div>
            </div>
          </div>

          {/* Security info */}
          <div style={{background:"#e8f5e9",borderRadius:10,padding:"10px 13px",fontSize:11,color:"#1a5c36",display:"flex",gap:8,alignItems:"flex-start"}}>
            <span style={{fontSize:16}}>🔒</span>
            <span>This certificate is digitally linked to inspection record <strong>{certView.id}</strong>. Any tampering invalidates the QR signature. Issued under AgriPass regulatory framework 2026.</span>
          </div>

          <button className="cert-print-btn" style={{marginTop:14}} onClick={()=>{showToast("🖨️ Sending to printer...");}}>🖨️ Print Certificate</button>
        </div>
      </div>
    </div>
  )}
</div>

);
}

// ─── AdminAssign sub-component ──────────────────────────────────────────────────────
function AdminAssign({ order, riders, onAssign, onUnassign }) {
const [sel, setSel] = useState(order.riderId || "");
return (
<div className="assign-row">
<select className="assign-select" value={sel} onChange={e => setSel(e.target.value)}>
<option value="">— Select a rider —</option>
{riders.filter(r => r.online).map(r => (
<option key={r.id} value={r.id}>🟢 {r.name} · {r.vehicle} · {r.zone}</option>
))}
{riders.filter(r => !r.online).map(r => (
<option key={r.id} value={r.id} disabled>⚫ {r.name} (Offline)</option>
))}
</select>
<button className="assign-btn" onClick={() => onAssign(sel)} disabled={!sel}>
{order.status === "assigned" ? "🔄 Reassign" : "🚴 Assign"}
</button>
{order.status === "assigned" && (
<button className="assign-btn unassign" onClick={onUnassign}>↩️</button>
)}
</div>
);
}

// ─── PhotoUpload — harvest photo upload with preview, compression, and upload ────────
//
// Flow:
//   1. Farmer taps zone or drag-drops up to 4 images
//   2. Each file is compressed client-side to ≤ 800px wide (Canvas API)
//   3. Compressed blob is POSTed to /api/uploads/presign → returns a Cloudflare
//      Images upload URL (direct-to-CDN — server never handles bytes)
//   4. Client uploads directly to the presigned URL
//   5. On success, the returned CDN URL is stored and passed to onChange()
//
// In demo mode (API_BASE empty): skips the real upload, uses a local
// object URL for instant preview with a simulated progress animation.
//
// Props:
//   photos   — current array of { url, name, size } objects
//   onChange — (updatedPhotos) => void
//   maxPhotos — default 4
//
const MAX_COMPRESS_PX = 800;
const MAX_FILE_MB     = 10;

function compressImage(file) {
return new Promise((resolve, reject) => {
const url = URL.createObjectURL(file);
const img = new Image();
img.onload = () => {
const scale = Math.min(1, MAX_COMPRESS_PX / Math.max(img.width, img.height));
const w = Math.round(img.width  * scale);
const h = Math.round(img.height * scale);
const canvas = document.createElement("canvas");
canvas.width  = w;
canvas.height = h;
canvas.getContext("2d").drawImage(img, 0, 0, w, h);
URL.revokeObjectURL(url);
canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("Compression failed")),
"image/jpeg", 0.82);
};
img.onerror = reject;
img.src = url;
});
}

async function uploadPhoto(file) {
// Demo mode — no real upload
if (!API_BASE) {
await new Promise(r => setTimeout(r, 600 + Math.random() * 600));
return { url: URL.createObjectURL(file), name: file.name, size: file.size };
}
// Production: get presigned URL from backend, upload directly to Cloudflare Images
const { uploadUrl, publicUrl } = await apiFetch("/api/uploads/presign", {
method: "POST",
body:   JSON.stringify({ filename: file.name, contentType: "image/jpeg" }),
});
const form = new FormData();
form.append("file", file);
const uploadResp = await fetch(uploadUrl, { method: "POST", body: form });
if (!uploadResp.ok) throw new Error(`Upload failed: HTTP ${uploadResp.status}`);
return { url: publicUrl, name: file.name, size: file.size };
}

function PhotoUpload({ photos = [], onChange, maxPhotos = 4 }) {
const [uploading, setUploading] = useState(false);
const [progress,  setProgress]  = useState(0);
const [status,    setStatus]    = useState(""); // "" | "ok" | "error"
const [statusMsg, setStatusMsg] = useState("");
const [drag,      setDrag]      = useState(false);

async function handleFiles(files) {
const remaining = maxPhotos - photos.length;
if (remaining <= 0) { setStatus("error"); setStatusMsg(`Max ${maxPhotos} photos allowed.`); return; }
const toProcess = Array.from(files).slice(0, remaining);

// Validate types and sizes
const invalid = toProcess.find(f => !f.type.startsWith("image/") || f.size > MAX_FILE_MB * 1024 * 1024);
if (invalid) { setStatus("error"); setStatusMsg(`Images only, max ${MAX_FILE_MB} MB each.`); return; }

setUploading(true);
setProgress(0);
setStatus("");

const results = [];
for (let i = 0; i < toProcess.length; i++) {
  try {
    const compressed = await compressImage(toProcess[i]);
    const result     = await uploadPhoto(new File([compressed], toProcess[i].name, { type:"image/jpeg" }));
    results.push(result);
    setProgress(Math.round(((i + 1) / toProcess.length) * 100));
  } catch {
    setStatus("error");
    setStatusMsg(`Failed to upload ${toProcess[i].name}.`);
  }
}

setUploading(false);
if (results.length) {
  const updated = [...photos, ...results];
  onChange(updated);
  setStatus("ok");
  setStatusMsg(`${results.length} photo${results.length > 1 ? "s" : ""} uploaded!`);
}

}

function removePhoto(idx) {
const updated = photos.filter((_, i) => i !== idx);
onChange(updated);
if (updated.length === 0) { setStatus(""); setStatusMsg(""); }
}

return (
<div>
{/* Drop zone */}
{photos.length < maxPhotos && (
<div
className={`pu-zone${drag ? " drag" : ""}`}
onDragOver={e => { e.preventDefault(); setDrag(true); }}
onDragLeave={() => setDrag(false)}
onDrop={e => { e.preventDefault(); setDrag(false); handleFiles(e.dataTransfer.files); }}
>
<input
type="file" accept="image/*" multiple capture="environment"
onChange={e => { handleFiles(e.target.files); e.target.value = ""; }}
/>
<div className="pu-icon">{uploading ? "⏳" : "📷"}</div>
<div className="pu-label">
<strong>Tap to photograph or choose files</strong>
Drag & drop images here
</div>
<div className="pu-hint">
JPG / PNG · max {MAX_FILE_MB} MB each · up to {maxPhotos} photos · compressed automatically
</div>
</div>
)}

  {/* Upload progress */}
  {uploading && (
    <div className="pu-progress-wrap">
      <div style={{fontSize:11,color:"var(--bark)"}}>Uploading... {progress}%</div>
      <div className="pu-progress-bar">
        <div className="pu-progress-fill" style={{width:`${progress}%`}}/>
      </div>
    </div>
  )}

  {/* Status message */}
  {status && (
    <div className={`pu-status ${status}`}>
      {status === "ok" ? "✅" : "⚠️"} {statusMsg}
    </div>
  )}

  {/* Photo previews */}
  {photos.length > 0 && (
    <div className="pu-previews">
      {photos.map((p, i) => (
        <div key={i} className="pu-thumb">
          <img src={p.url} alt={p.name}/>
          <button className="pu-thumb-remove" onClick={() => removePhoto(i)}
                  title="Remove photo">×</button>
        </div>
      ))}
    </div>
  )}

  {photos.length > 0 && (
    <div style={{fontSize:11,color:"#aaa",marginTop:6}}>
      {photos.length}/{maxPhotos} photo{photos.length > 1 ? "s" : ""} ·
      {!API_BASE && " Demo mode: previews only, not uploaded to CDN"}
    </div>
  )}
</div>

);
}

// ─── Route Optimisation ─────────────────────────────────────────────────────────────
//
// optimiseRoute(orders, riderLat, riderLng)
//
// Nearest-neighbour greedy algorithm — O(n²) which is optimal for n ≤ 10 stops
// (typical rider batch). For larger batches, swap with OSRM or Google Routes API.
//
// Algorithm:
//   1. Start from rider's current GPS position
//   2. At each step, pick the nearest unvisited active order
//   3. Repeat until all active orders are visited
//   4. Return sorted orders + cumulative distance + estimated time
//
// Returns:
//   { sortedOrders, totalKm, estMinutes, legs }
//   legs[i] = { fromLat, fromLng, toLat, toLng, distKm }
//
const RIDER_SPEED_KMH   = 25; // avg motorbike in Dar es Salaam / Nairobi urban
const STOP_OVERHEAD_MIN = 5;  // avg pickup/dropoff dwell time per stop

// Known address coordinates — production: geocode via Nominatim / Google Maps API
const ADDRESS_COORDS = {
"Mikocheni B, Dar es Salaam":   { lat:-6.7727, lng:39.2428 },
"Kariakoo, Dar es Salaam":      { lat:-6.8167, lng:39.2833 },
"Temeke, Dar es Salaam":        { lat:-6.8690, lng:39.2920 },
"South C, Nairobi":             { lat:-1.3167, lng:36.8433 },
"Kilimani, Nairobi":            { lat:-1.2921, lng:36.7862 },
"Langata, Nairobi":             { lat:-1.3701, lng:36.7542 },
};

function getOrderCoords(order) {
return ADDRESS_COORDS[order.address] ?? null;
}

function optimiseRoute(activeOrders, riderLat, riderLng) {
// Only route orders that have known coordinates and are active (not delivered/cancelled)
const routable = activeOrders
.filter(o => ["available","assigned","picked-up"].includes(o.status))
.map(o => ({ ...o, coords: getOrderCoords(o) }))
.filter(o => o.coords != null);

if (routable.length === 0) return { sortedOrders: activeOrders, totalKm: 0, estMinutes: 0, legs: [] };

const visited = new Set();
const sorted  = [];
const legs    = [];
let curLat = riderLat;
let curLng = riderLng;
let totalKm = 0;

while (visited.size < routable.length) {
let bestIdx  = -1;
let bestDist = Infinity;
routable.forEach((o, idx) => {
if (visited.has(idx)) return;
const d = parseFloat(calcDistKm(curLat, curLng, o.coords.lat, o.coords.lng));
if (!isNaN(d) && d < bestDist) { bestDist = d; bestIdx = idx; }
});
if (bestIdx === -1) break;
const next = routable[bestIdx];
legs.push({ fromLat:curLat, fromLng:curLng, toLat:next.coords.lat, toLng:next.coords.lng, distKm:bestDist });
totalKm += bestDist;
curLat = next.coords.lat;
curLng = next.coords.lng;
sorted.push(next);
visited.add(bestIdx);
}

const estMinutes = Math.round((totalKm / RIDER_SPEED_KMH) * 60 + sorted.length * STOP_OVERHEAD_MIN);

return { sortedOrders: sorted, totalKm: parseFloat(totalKm.toFixed(1)), estMinutes, legs };
}

// buildNavUrl(fromLat, fromLng, address)
// Returns a Google Maps directions deep-link for motorcycle navigation.
function buildNavUrl(riderLat, riderLng, destAddress, destCoords) {
const dest = destCoords
? `${destCoords.lat},${destCoords.lng}`
: encodeURIComponent(destAddress);
return `https://www.google.com/maps/dir/?api=1` +
`&origin=${riderLat},${riderLng}` +
`&destination=${dest}` +
`&travelmode=driving`;           // "driving" is closest to motorbike in Maps
}

// RouteCard — displays the optimised batch route above the order list
function RouteCard({ route, riderLat, riderLng }) {
const { sortedOrders, totalKm, estMinutes } = route;
if (sortedOrders.length === 0) return null;

return (
<div className="route-card">
<div className="route-card-hd">
<div className="route-card-title">🗺️ Optimised Route</div>
<div className="route-badge">{sortedOrders.length} Stop{sortedOrders.length > 1 ? "s" : ""}</div>
</div>

  <div className="route-stops">
    {sortedOrders.map((o, i) => {
      const coords = o.coords;
      const navUrl = buildNavUrl(riderLat, riderLng, o.address, coords);
      const legDist = route.legs[i]?.distKm?.toFixed(1) ?? "?";
      return (
        <div key={o.id} className="route-stop">
          <div className="route-stop-num">{i + 1}</div>
          <div className="route-stop-info">
            <div className="route-stop-addr">{o.address}</div>
            <div className="route-stop-meta">
              {o.id} · {o.customer} · {legDist} km from prev stop
            </div>
          </div>
          <a href={navUrl} target="_blank" rel="noreferrer">
            <button className="route-nav-btn" aria-label={`Navigate to ${o.address}`}>
              🧭 Go
            </button>
          </a>
        </div>
      );
    })}
  </div>

  <div className="route-summary">
    <div className="route-sum-item">
      <div className="route-sum-val">{totalKm} km</div>
      <div className="route-sum-lbl">Total Distance</div>
    </div>
    <div className="route-sum-item">
      <div className="route-sum-val">~{estMinutes} min</div>
      <div className="route-sum-lbl">Est. Time</div>
    </div>
    <div className="route-sum-item">
      <div className="route-sum-val">{sortedOrders.length}</div>
      <div className="route-sum-lbl">Deliveries</div>
    </div>
  </div>
</div>

);
}

// ─── OrderHistory — shows past orders with review prompt for delivered ones ──────────
// Fetches from apiService.getOrderHistory() on mount + country change.
// Demo mode: uses ORDERS_INIT filtered to delivered status.
//
// Props:
//   country  — active country code
//   cur      — display currency
//   onReview — (order) => void — opens ReviewModal for that order
//
function OrderHistory({ country, cur, onReview, onTrack }) {
const { data: history, loading } = useApi(
() => apiService.getOrderHistory(country),
[country]
);

if (loading) return null; // silent — no shimmer for history section
if (!history || history.length === 0) return null;

const ACTIVE_STATUSES = new Set(["assigned", "picked-up"]);

return (
<div className="order-hist" style={{padding:"0 4px"}}>
<h3>📦 Your Recent Orders</h3>
{history.map(o => {
const st = STATUS_LABELS[o.status] || STATUS_LABELS.available;
return (
<div key={o.id} className={`oh-card${o.status === "delivered" ? " delivered" : ""}`}>
<div className="oh-header">
<span className="oh-id">{o.id}</span>
<span className={`oh-status ${st.cls}`}>{st.icon} {st.label}</span>
</div>
<div className="oh-products">
{o.products.map(p => `${p.emoji} ${p.name} ${p.qty}`).join("  ·  ")}
</div>
<div className="oh-meta">
<span>🏭 {o.hub}</span>
<span>💰 {fmt(o.total, cur)}</span>
<span>🕐 {o.placed}</span>
</div>
{ACTIVE_STATUSES.has(o.status) && (
<button className="oh-review-btn" style={{background:"var(--forest)",color:"#fff"}}
        onClick={() => onTrack?.(o)}>
  🗺️ Track Order
</button>
)}
{o.status === "delivered" && (
<button className="oh-review-btn" onClick={() => onReview(o)}>
⭐ Leave a review
</button>
)}
</div>
);
})}
</div>
);
}

// ─── StarRating — interactive 1--5 star picker ────────────────────────────────────────
function StarRating({ value, onChange }) {
const [hover, setHover] = useState(0);
const labels = ["","Terrible","Poor","Okay","Good","Excellent"];
return (
<>
<div className="review-stars" role="radiogroup" aria-label="Product rating">
{[1,2,3,4,5].map(n => (
<span key={n}
role="radio"
aria-checked={n === value}
aria-label={`${n} star${n !== 1 ? "s" : ""}`}
tabIndex={n === (value || 1) ? 0 : -1}
className={`review-star${n <= (hover || value) ? " active" : ""}`}
onMouseEnter={() => setHover(n)}
onMouseLeave={() => setHover(0)}
onClick={() => onChange(n)}
onKeyDown={e => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onChange(n); }
  if (e.key === "ArrowRight" && n < 5) onChange(Math.min(5, n + 1));
  if (e.key === "ArrowLeft"  && n > 1) onChange(Math.max(1, n - 1));
}}
>
{n <= (hover || value) ? "⭐" : "☆"}
</span>
))}
</div>
<div className="review-labels">
<span>Terrible</span><span>Excellent</span>
</div>
{(hover || value) > 0 && (
<div style={{textAlign:"center",fontSize:13,fontWeight:700,color:"var(--forest)",marginBottom:8}}>
{labels[hover || value]}
</div>
)}
</>
);
}

// ─── ReviewModal — post-delivery review prompt ───────────────────────────────────────
// Shown automatically 30 s after an order moves to "delivered" status.
// In production: submits to POST /api/reviews → backend updates farmer's
// rolling average rating (last 50 reviews, weighted).
//
// Props:
//   order   — the delivered order object
//   onClose — called on submit or skip
//   onSubmit — (reviewData) => void  — updates reviews state in App
//   cur, country
//
function ReviewModal({ order, onClose, onSubmit, cur }) {
const [rating,  setRating]  = useState(0);
const [comment, setComment] = useState("");
const [loading, setLoading] = useState(false);
const [done,    setDone]    = useState(false);
const closeTimerRef = useRef(null);

useEffect(() => () => clearTimeout(closeTimerRef.current), []);

const MAX_CHARS = 200;

async function handleSubmit() {
if (rating === 0) return;
setLoading(true);
// In production: await apiService.submitReview({ orderId, rating, comment })
if (API_BASE) {
try {
await apiFetch("/api/reviews", {
method: "POST",
body: JSON.stringify({
orderId:    order.id,
rating,
comment:    comment.trim(),
farmerId:   order.products?.[0]?.name, // production: use real farmerId
country:    order.country,
}),
});
} catch (err) { log.warn("[review] Backend sync failed:", err.message); }
}
await new Promise(r => setTimeout(r, 600)); // simulate API delay in demo
const review = {
id:         `REV-${Date.now().toString().slice(-6)}`,
orderId:    order.id,
farmerName: order.products?.[0]?.name ?? "Farmer",
product:    order.products?.map(p => p.name).join(", ") ?? "",
rating,
comment:    comment.trim(),
customer:   order.customer ?? "Customer",
country:    order.country,
createdAt:  new Date().toLocaleString("en-TZ"),
};
onSubmit(review);
setLoading(false);
setDone(true);
closeTimerRef.current = setTimeout(onClose, 1800);
}

if (done) return (
<div className="review-modal-bd">
<div className="review-modal" style={{textAlign:"center",paddingTop:40,paddingBottom:40}}>
<div style={{fontSize:56,marginBottom:12}}>🌟</div>
<div className="review-title">Thank you!</div>
<div className="review-sub">Your review helps other buyers and supports {order.products?.[0]?.name ?? "the farmer"}.</div>
</div>
</div>
);

return (
<div className="review-modal-bd" role="dialog" aria-modal="true" aria-label="Rate your order"
onClick={e => e.target === e.currentTarget && onClose()}>
<div className="review-modal">
<div className="review-handle"/>
<div className="review-title">Rate your order</div>
<div className="review-sub">
Order {order.id} · {order.products?.map(p => `${p.name} ${p.qty}`).join(", ")}
</div>

    <div style={{fontWeight:700,fontSize:12,color:"var(--bark)",marginBottom:10}}>
      How would you rate this farmer's produce?
    </div>

    <StarRating value={rating} onChange={setRating}/>

    <textarea
      className="review-textarea"
      rows={3}
      maxLength={MAX_CHARS}
      placeholder="Tell other buyers what you thought — freshness, packaging, accuracy..."
      value={comment}
      onChange={e => setComment(e.target.value.slice(0, MAX_CHARS))}
    />
    <div className="review-char">{comment.length}/{MAX_CHARS}</div>

    <button className="review-submit" disabled={rating === 0 || loading} onClick={handleSubmit}>
      {loading
        ? <span style={{display:"flex",alignItems:"center",justifyContent:"center",gap:8}}>
            <div className="spinner" style={{width:16,height:16,borderWidth:2,margin:0}}/>
            Submitting...
          </span>
        : `⭐ Submit Review${rating > 0 ? ` (${rating} star${rating > 1 ? "s" : ""})` : ""}`}
    </button>
    <button className="review-skip" onClick={onClose}>Skip for now</button>
  </div>
</div>

);
}

// ─── PayoutLedger — farmer earnings breakdown per order ─────────────────────────────
// Shows pending, processing, and paid payouts with full commission breakdown.
// In production: fetches from /api/payouts?farmerId=xxx via apiService.
//
// Props:
//   entries  — array of payout objects (from PAYOUT_LEDGER_INIT / API)
//   cur      — display currency code
//   country  — active country (for commission calc labels)
//
function PayoutLedger({ entries, cur, country }) {
const [expanded, setExpanded] = useState(null);

const myEntries = entries.filter(e => e.country === country);

const totalPaid       = myEntries.filter(e => e.status === "paid").reduce((s,e) => s + e.netFarmer, 0);
const totalPending    = myEntries.filter(e => e.status !== "paid").reduce((s,e) => s + e.netFarmer, 0);
const totalCommission = myEntries.reduce((s,e) => s + e.commissionAmt + (e.flatFee||0), 0);

if (myEntries.length === 0) return (
<div style={{textAlign:"center",padding:"24px 0",color:"#aaa",fontSize:13}}>
No payouts yet — your first payout arrives within 2 hrs of delivery confirmation.
</div>
);

return (
<>
{/* KPI summary row */}
<div className="payout-summary">
<div className="payout-kpi">
<div className="payout-kpi-val">{fmt(totalPaid, cur)}</div>
<div className="payout-kpi-lbl">✅ Total Received</div>
</div>
<div className="payout-kpi">
<div className="payout-kpi-val">{fmt(totalPending, cur)}</div>
<div className="payout-kpi-lbl">⏳ Awaiting Payout</div>
</div>
<div className="payout-kpi">
<div className="payout-kpi-val">{myEntries.length}</div>
<div className="payout-kpi-lbl">📦 Total Orders</div>
</div>
<div className="payout-kpi">
<div className="payout-kpi-val">{fmt(totalCommission, cur)}</div>
<div className="payout-kpi-lbl">💼 Platform Fee</div>
</div>
</div>

  {/* Payout rows */}
  {myEntries.map(e => {
    const st   = PAYOUT_STATUS[e.status] || PAYOUT_STATUS.pending;
    const isEx = expanded === e.id;
    const payIcon = e.method === "mpesa" ? "📱" : e.method === "tigopesa" ? "📲" : "🏦";
    return (
      <div key={e.id} className="payout-row" onClick={() => setExpanded(isEx ? null : e.id)}
           style={{cursor:"pointer"}}>
        <div className="payout-icon">{payIcon}</div>
        <div className="payout-detail">
          <div className="payout-product">{e.product}</div>
          <div className="payout-meta">
            {e.orderId} · {e.paidAt ? new Date(e.paidAt).toLocaleString("en-TZ",{dateStyle:"short",timeStyle:"short"}) : "Awaiting"}
          </div>
          <div className={`ps-badge ${st.cls}`}>{st.icon} {st.label}</div>

          {/* Expandable breakdown */}
          {isEx && (
            <div className="payout-breakdown">
              {[
                ["Order value",   e.gross],
                [`Commission (${getCfg(country).commission.pct}%)`, -e.commissionAmt],
                ...(e.flatFee ? [["Flat fee", -e.flatFee]] : []),
                ...(e.vatAmt  ? [["VAT on fee (18%)", -e.vatAmt]] : []),
              ].map(([label, amt]) => (
                <div key={label} className="payout-breakdown-row">
                  <span>{label}</span>
                  <span style={{color: amt < 0 ? "#c0392b" : "inherit"}}>
                    {amt < 0 ? "−" : ""}{fmt(Math.abs(amt), cur)}
                  </span>
                </div>
              ))}
              <div className="payout-breakdown-row net">
                <span>Your payout</span>
                <span>{fmt(e.netFarmer, cur)}</span>
              </div>
              {e.status === "paid" && (
                <div style={{fontSize:10,color:"#27ae60",marginTop:4}}>
                  ✅ Sent to {e.method === "mpesa" ? "M-Pesa" : "Tigo Pesa"} · {e.paidAt}
                </div>
              )}
            </div>
          )}
        </div>
        <div className="payout-amount">
          <div className="payout-net">{fmt(e.netFarmer, cur)}</div>
          <div className="payout-gross">of {fmt(e.gross, cur)}</div>
        </div>
      </div>
    );
  })}
</>

);
}

// ─── AddressPicker — map-based delivery address input ───────────────────────────────
// Shows a text input + GPS button. When GPS succeeds, renders a lightweight SVG
// "map" centred on the user's pin, distance to the nearest hub, and a simulated
// what3words address (format: ///word.word.word).
//
// In production: swap the SVG canvas for a Leaflet map + OpenStreetMap tiles and
// call the real what3words API to get the three-word address.
//
// Props:
//   country  — "TZ" | "KE"  (controls hub centre and placeholder text)
//   value    — current delivery address string
//   onChange — (addressObj) => void  where addressObj = { text, lat, lng, w3w, distKm }
//
function AddressPicker({ country, value, onChange }) {
const [textInput, setTextInput]   = useState(value?.text || "");
const [pin,       setPin]         = useState(value?.lat ? value : null);
const [gpsLoading,setGpsLoading]  = useState(false);
const [error,     setError]       = useState("");

const hub = getCfg(country).hub.name;
const hubCoord = getCfg(country).hub.coords;

// Simulate a what3words address from coordinates (deterministic mock)
function mockW3W(lat, lng) {
const words = ["pillar","market","window","fresh","valley","river","table",
"stone","silver","bright","field","garden","mango","copper","swift"];
const hash = n => Math.abs(Math.round(n * 1000)) % words.length;
return `///${words[hash(lat)]}.${words[hash(lng)]}.${words[hash(lat+lng)]}`;
}

function commitText() {
if (!textInput.trim()) { setError("Please enter a delivery address."); return; }
setError("");
setPin(null); // text-only address, no GPS pin
onChange({ text: textInput.trim(), lat: null, lng: null, w3w: null, distKm: null });
}

function handleGPS() {
if (!navigator.geolocation) {
setError("GPS not available on this device.");
return;
}
setGpsLoading(true);
setError("");
navigator.geolocation.getCurrentPosition(
pos => {
const { latitude: lat, longitude: lng } = pos.coords;
const distKm = calcDistKm(lat, lng, hubCoord.lat, hubCoord.lng);
const w3w    = mockW3W(lat, lng);
const text   = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
setPin({ lat, lng, w3w, distKm });
setTextInput(text);
setGpsLoading(false);
onChange({ text, lat, lng, w3w, distKm });
},
() => {
// GPS blocked in sandbox — use hub location as demo pin
const lat = hubCoord.lat + (Math.random() - 0.5) * 0.02;
const lng = hubCoord.lng + (Math.random() - 0.5) * 0.02;
const distKm = calcDistKm(lat, lng, hubCoord.lat, hubCoord.lng);
const w3w    = mockW3W(lat, lng);
const text   = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
setPin({ lat, lng, w3w, distKm });
setTextInput(text);
setGpsLoading(false);
onChange({ text, lat, lng, w3w, distKm });
},
{ timeout: 8000, maximumAge: 60000 }
);
}

return (
<div className="addr-wrap">
<div className="addr-label">
📍 Delivery Address
</div>

  <div className="addr-input-row">
    <input
      className={`addr-input${error ? " error" : ""}`}
      type="text"
      placeholder={country === "TZ"
        ? "e.g. Mikocheni B, Dar es Salaam or tap 📍"
        : "e.g. Kilimani, Nairobi or tap 📍"}
      value={textInput}
      onChange={e => { setTextInput(e.target.value); setError(""); }}
      onBlur={commitText}
    />
    <button
      className="addr-gps-btn"
      title="Use my current location"
      disabled={gpsLoading}
      onClick={handleGPS}
    >
      {gpsLoading
        ? <span className="spinner" style={{width:16,height:16,borderWidth:2,display:"inline-block"}}/>
        : "📍"}
    </button>
  </div>

  {error && <div className="addr-error">⚠️ {error}</div>}

  {/* Map canvas — SVG placeholder; swap for Leaflet in production */}
  {pin && (
    <div className="addr-map-wrap">
      <div className="addr-map-inner">
        {/* Lightweight SVG map grid */}
        <svg width="100%" height="100%" style={{position:"absolute",top:0,left:0,opacity:.18}}>
          {[0,1,2,3,4,5,6,7,8,9,10].map(i => (
            <g key={i}>
              <line x1={`${i*10}%`} y1="0" x2={`${i*10}%`} y2="100%" stroke="#2d6a4f" strokeWidth=".5"/>
              <line x1="0" y1={`${i*10}%`} x2="100%" y2={`${i*10}%`} stroke="#2d6a4f" strokeWidth=".5"/>
            </g>
          ))}
        </svg>
        {/* Hub marker */}
        <div style={{position:"absolute",top:"35%",left:"45%",fontSize:22,filter:"drop-shadow(0 2px 4px rgba(0,0,0,.3))"}}>
          🏭
        </div>
        {/* User pin */}
        <div style={{position:"absolute",top:"55%",left:"58%",textAlign:"center"}}>
          <div className="addr-pin">📍</div>
        </div>
        {/* Hub label */}
        <div style={{position:"absolute",top:8,left:8,fontSize:10,fontWeight:700,
                     color:"var(--forest)",background:"white",borderRadius:6,padding:"2px 6px",
                     opacity:.9}}>
          🏭 {hub}
        </div>
        {/* Distance badge */}
        <div style={{position:"absolute",bottom:8,right:8,fontSize:11,fontWeight:700,
                     color:"white",background:"var(--forest)",borderRadius:8,padding:"3px 8px"}}>
          {pin.distKm.toFixed(1)} km from hub
        </div>
      </div>
    </div>
  )}

  {/* Confirmed address card */}
  {(pin || (textInput && !error)) && (
    <div className="addr-confirmed">
      <div className="addr-confirmed-icon">✅</div>
      <div>
        <div style={{fontWeight:700,fontSize:12,marginBottom:2}}>Delivery location confirmed</div>
        <div style={{color:"#666",fontSize:11}}>{textInput}</div>
        {pin?.w3w && (
          <div className="addr-w3w" style={{marginTop:4,display:"inline-block"}}>
            🟪 {pin.w3w}
            <span style={{fontSize:10,color:"#888",fontWeight:400,marginLeft:4}}>what3words</span>
          </div>
        )}
        {pin?.distKm != null && (
          <div style={{fontSize:11,color:"var(--bark)",marginTop:4}}>
            📏 {pin.distKm.toFixed(1)} km from {hub} · {fmt(getCfg(country).deliveryFee, getCfg(country).currency)} delivery fee
          </div>
        )}
      </div>
    </div>
  )}
</div>

);
}

// ─── PaymentGateway component ───────────────────────────────────────────────────────
// ─── generateInvoicePDF ──────────────────────────────────────────────────────
// Produces a downloadable PDF invoice using only the Canvas API and the
// Blob / URL.createObjectURL browser APIs — zero external libraries.
//
// Strategy:
//   1. Draw invoice layout on an offscreen <canvas>
//   2. Export canvas as PNG data-URL
//   3. Embed PNG inside a minimal hand-crafted PDF binary
//   4. Trigger browser download via <a> click
//
// The resulting PDF is single-page, A4 proportion, ~60--80 KB.
function generateInvoicePDF({ refNum, totalTZS, cur, country, cart, qty,
deliveryAddress, vfd, couponResult, loyaltyPts,
paymentMethod }) {
// ── 1. Build invoice data strings ──────────────────────────────────────────
const cfg        = getCfg(country);
const now        = new Date();
const dateStr    = now.toLocaleDateString("en-GB", { day:"2-digit", month:"short", year:"numeric" });
const timeStr    = now.toLocaleTimeString("en-GB", { hour:"2-digit", minute:"2-digit" });
const subtotal   = cart.reduce((s,p) => s + p.tzsPrice * (qty[p.id] || 1), 0);
const discount   = couponResult?.valid ? couponResult.discount : 0;
const delivery   = cfg.deliveryFee;
const commission = calcCommission(subtotal, country).commissionAmt;
const total      = subtotal - discount + delivery;

// ── 2. Draw on canvas ──────────────────────────────────────────────────────
const W = 794, H = 1123;  // A4 at 96 dpi
const canvas = document.createElement("canvas");
canvas.width = W; canvas.height = H;
const ctx = canvas.getContext("2d");

// Background
ctx.fillStyle = "#ffffff";
ctx.fillRect(0, 0, W, H);

// Header bar
ctx.fillStyle = "#1a3a2a";
ctx.fillRect(0, 0, W, 110);

// Brand name
ctx.fillStyle = "#f4c430";
ctx.font = "bold 28px Georgia, serif";
ctx.fillText("Asiel Farm Shop", 40, 52);
ctx.fillStyle = "rgba(255,255,255,0.7)";
ctx.font = "14px Arial, sans-serif";
ctx.fillText("Farm-to-Fork Marketplace  ·  " + cfg.city + ", " + cfg.name, 40, 78);
ctx.fillText("privacy@asfarm.tz  ·  asfarm.tz", 40, 98);

// Invoice label top-right
ctx.fillStyle = "#ffffff";
ctx.font = "bold 22px Arial, sans-serif";
ctx.textAlign = "right";
ctx.fillText("TAX INVOICE", W - 40, 52);
ctx.font = "13px Arial, sans-serif";
ctx.fillStyle = "rgba(255,255,255,0.7)";
ctx.fillText(`Ref: ${refNum}`, W - 40, 74);
ctx.fillText(`${dateStr}  ${timeStr}`, W - 40, 94);
ctx.textAlign = "left";

let y = 140;

// ── Invoice meta ────────────────────────────────────────────────────────────
const drawRow = (label, value, bold = false, highlight = false) => {
if (highlight) {
ctx.fillStyle = "#f7f3ec";
ctx.fillRect(32, y - 16, W - 64, 24);
}
ctx.fillStyle = "#888";
ctx.font = `12px Arial, sans-serif`;
ctx.fillText(label, 40, y);
ctx.fillStyle = bold ? "#1a3a2a" : "#333";
ctx.font = bold ? "bold 13px Arial, sans-serif" : "13px Arial, sans-serif";
ctx.textAlign = "right";
ctx.fillText(value, W - 40, y);
ctx.textAlign = "left";
y += 26;
};

ctx.fillStyle = "#555";
ctx.font = "12px Arial, sans-serif";
ctx.fillText("Deliver to:", 40, y);
ctx.fillStyle = "#1a3a2a";
ctx.font = "bold 13px Arial, sans-serif";
ctx.fillText(deliveryAddress?.text || "Collected at hub", 160, y);
y += 26;
ctx.fillStyle = "#555";
ctx.font = "12px Arial, sans-serif";
ctx.fillText("Payment via:", 40, y);
ctx.fillStyle = "#333";
ctx.font = "13px Arial, sans-serif";
ctx.fillText(paymentMethod || "Express Pay", 160, y);
y += 30;

// Divider
ctx.strokeStyle = "#e0e0e0"; ctx.lineWidth = 1;
ctx.beginPath(); ctx.moveTo(40, y); ctx.lineTo(W - 40, y); ctx.stroke();
y += 20;

// ── Items table header ──────────────────────────────────────────────────────
ctx.fillStyle = "#f0f0f0";
ctx.fillRect(32, y - 14, W - 64, 24);
ctx.fillStyle = "#555";
ctx.font = "bold 11px Arial, sans-serif";
ctx.fillText("ITEM", 44, y);
ctx.textAlign = "center"; ctx.fillText("QTY", 520, y);
ctx.textAlign = "right";  ctx.fillText("UNIT PRICE", 660, y);
ctx.fillText("TOTAL", W - 44, y);
ctx.textAlign = "left";
y += 28;

// ── Line items ──────────────────────────────────────────────────────────────
cart.forEach((p, i) => {
const q     = qty[p.id] || 1;
const line  = p.tzsPrice * q;
if (i % 2 === 0) {
ctx.fillStyle = "#fafafa";
ctx.fillRect(32, y - 14, W - 64, 24);
}
ctx.fillStyle = "#222";
ctx.font = "12px Arial, sans-serif";
ctx.fillText(`${p.emoji || "🌿"}  ${p.name}`, 44, y);
ctx.fillStyle = "#555";
ctx.textAlign = "center"; ctx.fillText(String(q), 520, y);
ctx.textAlign = "right";  ctx.fillText("TZS " + p.tzsPrice.toLocaleString(), 660, y);
ctx.fillStyle = "#1a3a2a"; ctx.font = "bold 12px Arial, sans-serif";
ctx.fillText("TZS " + line.toLocaleString(), W - 44, y);
ctx.textAlign = "left";
y += 26;
});
y += 8;

// Divider
ctx.strokeStyle = "#ccc";
ctx.beginPath(); ctx.moveTo(40, y); ctx.lineTo(W - 40, y); ctx.stroke();
y += 20;

// ── Totals section ──────────────────────────────────────────────────────────
drawRow("Subtotal", "TZS " + subtotal.toLocaleString());
if (discount > 0) drawRow("Discount (" + (couponResult?.code || "LOYALTY") + ")", "− TZS " + discount.toLocaleString());
drawRow("Hub & Delivery Fee", "TZS " + delivery.toLocaleString());
drawRow("Platform Commission (" + cfg.commission.pct + "%)", "TZS " + commission.toLocaleString());
y += 4;
ctx.fillStyle = "#1a3a2a";
ctx.fillRect(32, y - 16, W - 64, 32);
ctx.fillStyle = "#ffffff";
ctx.font = "bold 15px Arial, sans-serif";
ctx.fillText("TOTAL DUE", 44, y + 2);
ctx.textAlign = "right";
ctx.fillText("TZS " + total.toLocaleString(), W - 44, y + 2);
ctx.textAlign = "left";
y += 42;

// ── TRA fiscal receipt block (TZ only) ─────────────────────────────────────
if (vfd && vfd !== "loading" && vfd !== "error" && country === "TZ") {
ctx.fillStyle = "#e8f5e9";
ctx.fillRect(32, y, W - 64, 120);
ctx.strokeStyle = "#2d6a4f"; ctx.lineWidth = 1.5;
ctx.strokeRect(32, y, W - 64, 120);
y += 20;
ctx.fillStyle = "#155724";
ctx.font = "bold 13px Arial, sans-serif";
ctx.fillText("🏛️  TRA Fiscal Receipt (Official)", 44, y); y += 22;
ctx.fillStyle = "#333"; ctx.font = "11px Arial, sans-serif";
ctx.fillText(`Receipt No: ${vfd.receiptNumber}   Fiscal No: ${vfd.fiscalNumber}`, 44, y); y += 18;
ctx.fillText(`TIN: ${vfd.tin}   VRN: ${vfd.vrn}   VAT (18%): TZS ${vfd.vat?.toLocaleString()}`, 44, y); y += 18;
ctx.fillText(`Verify at: verify.tra.go.tz  ·  ${vfd.fiscalNumber}`, 44, y); y += 30;
} else {
y += 10;
}

// ── Loyalty earned ──────────────────────────────────────────────────────────
const ptsEarned = earnPoints(total);
ctx.fillStyle = "#f5f0e8";
ctx.fillRect(32, y, W - 64, 36);
ctx.fillStyle = "#856404";
ctx.font = "bold 12px Arial, sans-serif";
ctx.fillText(`⭐  Loyalty points earned this order: +${ptsEarned} pts   ·   Balance after: ${loyaltyPts + ptsEarned} pts`, 44, y + 22);
y += 56;

// ── Footer ──────────────────────────────────────────────────────────────────
ctx.strokeStyle = "#e0e0e0";
ctx.beginPath(); ctx.moveTo(40, y); ctx.lineTo(W - 40, y); ctx.stroke();
y += 20;
ctx.fillStyle = "#aaa";
ctx.font = "11px Arial, sans-serif";
ctx.fillText("Thank you for shopping with Asiel Farm Shop. For queries: support@asfarm.tz  ·  +255 800 111 222", 40, y); y += 18;
ctx.fillText("This document is a valid tax invoice. All prices in Tanzanian Shilling (TZS). Powered by Asiel Farm Shop Ltd.", 40, y); y += 18;
ctx.fillText(`Generated: ${dateStr} ${timeStr}  ·  Ref: ${refNum}  ·  © ${now.getFullYear()} Asiel Farm Shop Ltd. All rights reserved.`, 40, y);

// ── 3. Encode canvas → minimal PDF ────────────────────────────────────────
const imgData = canvas.toDataURL("image/jpeg", 0.92);
const b64     = imgData.split(",")[1];
const imgLen  = Math.ceil(b64.length * 3 / 4);

const pdfParts = [
`%PDF-1.4\n`,
`1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`,
`2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n`,
`3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Contents 4 0 R /Resources << /XObject << /Im1 5 0 R >> >> >>\nendobj\n`,
`4 0 obj\n<< /Length 32 >>\nstream\nq ${W} 0 0 ${H} 0 0 cm /Im1 Do Q\nendstream\nendobj\n`,
`5 0 obj\n<< /Type /XObject /Subtype /Image /Width ${W} /Height ${H} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${imgLen} >>\nstream\n`,
];

const header = pdfParts.join("");
const trailer = `\nendstream\nendobj\nxref\n0 6\n0000000000 65535 f \ntell trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${header.length}\n%%EOF`;

// Convert base64 image to binary
const binary = atob(b64);
const bytes  = new Uint8Array(binary.length);
for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

const blob = new Blob(
[header, bytes, trailer],
{ type: "application/pdf" }
);

const url = URL.createObjectURL(blob);
const a   = document.createElement("a");
a.href = url;
a.download = `AsielFarmShop-Invoice-${refNum}.pdf`;
document.body.appendChild(a);
a.click();
setTimeout(() => { URL.revokeObjectURL(url); document.body.removeChild(a); }, 1000);

analytics.capture("invoice.downloaded", { ref: refNum, totalTZS: total, country });
}

const ALL_PAY_METHODS = {
tigopesa: { icon:"📲", cls:"tigopesa", name:"Tigo Pesa / Vodacom", sub:"USSD push to your mobile number" },
mpesa:    { icon:"📱", cls:"mpesa",    name:"M-Pesa",              sub:"USSD push to your mobile number" },
selcom:   { icon:"💚", cls:"selcom",   name:"Selcom Pay",          sub:"Selcom Wireless · Tanzania"      },
airtel:   { icon:"🔴", cls:"airtel",   name:"Airtel Money",        sub:"Airtel mobile wallet"            },
mtn_momo: { icon:"🟡", cls:"mtn",      name:"MTN MoMo",            sub:"MTN Mobile Money wallet"         },
opay:     { icon:"🟠", cls:"opay",     name:"OPay",                sub:"OPay digital wallet"             },
card:     { icon:"💳", cls:"card",     name:"Debit / Credit Card", sub:"Visa · Mastercard · Amex"        },
bank:     { icon:"🏦", cls:"bank",     name:"Bank Transfer",       sub:`${getCfg(country).taxBody} · ${getCfg(country).regulator}` },
};

// ─── PaymentGatewayWithStripe — wraps PaymentGateway in Stripe Elements context ──
// This is the component used by the rest of the app. PaymentGateway itself uses
// useStripe() / useElements() which require the Elements provider to be an ancestor.
function PaymentGatewayWithStripe(props) {
const appearance = { theme: "night", variables: { colorPrimary: "#2d6a4f", borderRadius: "10px" } };
return (
  <Elements stripe={stripePromise} options={{ appearance }}>
    <PaymentGateway {...props} />
  </Elements>
);
}

function PaymentGateway({ totalTZS, cur, country, onClose, onSuccess,
cart = [], qty = {}, couponResult = null, loyaltyPts = 0 }) {
const stripe   = useStripe();
const elements = useElements();
const [method, setMethod]         = useState(null);
const [cardError, setCardError]   = useState("");   // Stripe CardElement error message
const [phone, setPhone]           = useState("");
const [phoneError, setPhoneError] = useState("");
const paySheetRef = useRef(null); // focus trap for payment sheet
useFocusTrap(paySheetRef, true);  // always active while PaymentGateway is mounted
const [deliveryAddress, setDeliveryAddress] = useState(null); // { text, lat, lng, w3w, distKm }
const [stage, setStage]           = useState("choose");
const [expressAnim, setExpressAnim] = useState(null);
// TRA VFD receipt state
const [vfd, setVfd]               = useState(null);   // null | object | "loading" | "error"

const displayAmt = fmt(totalTZS, cur);
const tzsAmt     = `TZS ${totalTZS.toLocaleString()}`;
const refNum     = useRef(secureId("SF")).current;
const pollRef    = useRef(null); // tracks active payment polling interval

useEffect(() => { return () => clearInterval(pollRef.current); }, []);

useEffect(() => {
if (stage === "success") {
  elements?.getElement(CardElement)?.clear();
  setCardError("");
}
}, [stage, elements]);

useEffect(() => {
const h = e => { if (e.key === "Escape") onClose(); };
document.addEventListener("keydown", h);
return () => document.removeEventListener("keydown", h);
}, [onClose]);

// When stage transitions to "success", request the TRA VFD receipt (TZ only)
useEffect(() => {
if (stage !== "success") return;
if (country !== "TZ") return;         // VFD required in Tanzania only
setVfd("loading");
apiService.generateVFD({
orderId:       refNum,
amount:        totalTZS,
ref:           refNum,
country,
paymentMethod: method || expressAnim || "express",
}).then(receipt => {
setVfd(receipt?.status === "error" ? "error" : receipt);
}).catch(() => setVfd("error"));
}, [stage, country, totalTZS, refNum, method, expressAnim]);

// Payment methods are driven by the country registry — no more hardcoded ternaries
const payMethods = (getCfg(country).payments || ["card","bank"])
.map(id => ({ id, ...ALL_PAY_METHODS[id] }))
.filter(Boolean);

const MOBILE_MONEY_METHODS = ["mpesa","tigopesa","selcom","airtel","mtn_momo","opay"];

// Express pay: in demo mode uses timeout; in production calls initiatePayment API
const handleExpress = async (type) => {
setExpressAnim(type);
setStage("processing");
if (!API_BASE) {
// Demo mode — simulate 2.4s processing delay
setTimeout(() => setStage("success"), PAYMENT_DEMO_DELAY_MS);
return;
}
try {
const { ref } = await apiService.initiatePayment({
method: type, amount: totalTZS, currency: "tzs", orderId: refNum, country,
});
// Poll every 3s until confirmed (max 2 minutes)
clearInterval(pollRef.current); // cancel any previous poll before starting
let attempts = 0;
pollRef.current = setInterval(async () => {
attempts++;
const status = await apiService.pollPaymentStatus(ref);
if (status.status === "success") { clearInterval(pollRef.current); setStage("success"); }
if (status.status === "failed" || attempts > 40) {
clearInterval(pollRef.current); setStage("choose");
alert("Payment failed or timed out. Please try again.");
}
}, 3000);
} catch (err) {
setStage("choose");
alert("Payment error: " + err.message);
}
};

const handlePay = async () => {
if (!method) return;
if (API_BASE && !_csrfToken) { alert("Session expired — please refresh and try again."); return; }
// Require delivery address before payment
if (!deliveryAddress?.text) {
document.querySelector(".addr-wrap")?.scrollIntoView({ behavior:"smooth", block:"center" });
return;
}
// Validate phone for all mobile-money methods before hitting payment API
if (MOBILE_MONEY_METHODS.includes(method)) {
const { valid, e164, error } = validatePhone(phone);
if (!valid) { setPhoneError(error); return; }
setPhoneError("");
setPhone(e164);
}
// Card-specific validation using Stripe Elements
if (method === "card") {
  if (API_BASE) {
    if (!stripe || !elements) { alert("Payment system not ready — please wait a moment."); return; }
    setStage("processing");
    const cardEl = elements.getElement(CardElement);
    const { paymentMethod, error } = await stripe.createPaymentMethod({ type: "card", card: cardEl });
    if (error) { setStage("choose"); setCardError(error.message); return; }
    setCardError("");
    // Send paymentMethod.id to backend; backend creates PaymentIntent and returns clientSecret
    try {
      const { ref, clientSecret } = await apiService.initiatePayment({ method: "card", paymentMethodId: paymentMethod.id, amount: totalTZS, currency: "tzs", orderId: refNum, country });
      // Confirm the charge client-side — without this the PaymentIntent stays in requires_confirmation
      if (clientSecret) {
        const { error: confirmError } = await stripe.confirmCardPayment(clientSecret, {
          payment_method: paymentMethod.id,
        });
        if (confirmError) { setStage("choose"); setCardError(confirmError.message); return; }
      }
      clearInterval(pollRef.current);
      let attempts = 0;
      pollRef.current = setInterval(async () => {
        attempts++;
        const status = await apiService.pollPaymentStatus(ref);
        if (status.status === "completed") { clearInterval(pollRef.current); setStage("success"); }
        if (status.status === "failed" || attempts > 40) { clearInterval(pollRef.current); setStage("choose"); alert("Payment failed. Please try again."); }
      }, 3000);
    } catch (err) { setStage("choose"); alert("Payment error: " + err.message); }
    return;
  }
  // Demo mode — simulate card payment
  setStage("processing");
  setTimeout(() => setStage("success"), PAYMENT_DEMO_DELAY_MS);
  return;
}
setStage("processing");
if (!API_BASE) {
// Demo mode — simulate processing delay
setTimeout(() => setStage("success"), PAYMENT_DEMO_DELAY_MS);
return;
}
try {
const { ref } = await apiService.initiatePayment({
method, phone, amount: totalTZS, currency: "tzs", orderId: refNum, country,
});
// Poll for payment confirmation
let attempts = 0;
const poll = setInterval(async () => {
attempts++;
const status = await apiService.pollPaymentStatus(ref);
if (status.status === "success") { clearInterval(pollRef.current); setStage("success"); }
if (status.status === "failed" || attempts > 40) {
clearInterval(pollRef.current); setStage("choose");
alert("Payment failed or timed out. Please try again.");
}
}, 3000);
} catch (err) {
setStage("choose");
alert("Payment error: " + err.message);
}
};

if (stage === "processing") return (
<div className="pay-backdrop" role="dialog" aria-modal="true" aria-label="Secure checkout">
<div className="pay-sheet">
<div className="pay-handle"/>
<div className="processing-screen">
<div className="spinner"/>
<div className="processing-title">Processing Payment...</div>
<div className="processing-sub">Securely communicating with {
expressAnim==="apple"  ? "Apple Pay"  : expressAnim==="google" ? "Google Pay"  :
expressAnim==="paypal" ? "PayPal"     : method==="card"        ? "Stripe Gateway" :
method==="mpesa"       ? "M-Pesa"     : method==="tigopesa"   ? "Tigo Pesa"   :
method==="selcom"      ? "Selcom Pay" : method==="airtel"     ? "Airtel Money" : "your bank"
}...</div>
<div style={{marginTop:20,fontSize:12,color:"#ccc"}}>🔒 256-bit SSL · PCI DSS compliant</div>
</div>
</div>
</div>
);

if (stage === "success") return (
<div className="pay-backdrop" role="dialog" aria-modal="true" aria-label="Secure checkout">
<div className="pay-sheet">
<div className="pay-handle"/>
<div className="pay-success">
<div className="success-ring">✓</div>
<div className="success-title">Payment Confirmed!</div>
<div className="success-sub">
Your order has been placed and farmers have been notified.
{expressAnim==="apple"  && " Paid via Apple Pay."}
{expressAnim==="google" && " Paid via Google Pay."}
{expressAnim==="paypal" && " Paid via PayPal."}
{!expressAnim && method==="card"     && " Paid via card (Stripe)."}
{!expressAnim && method==="mpesa"    && " Paid via M-Pesa."}
{!expressAnim && method==="tigopesa" && " Paid via Tigo Pesa."}
{!expressAnim && method==="selcom"   && " Paid via Selcom Pay."}
{!expressAnim && method==="airtel"   && " Paid via Airtel Money."}
{!expressAnim && method==="bank"     && " Bank transfer initiated."}
</div>
<div className="success-amount">{displayAmt}</div>
{cur !== "TZS" && <div style={{fontSize:12,color:"#aaa"}}>≈ {tzsAmt}</div>}
<div className="success-ref">Ref: {refNum}</div>

      {/* Confirmed delivery address */}
      {deliveryAddress?.text && (
        <div style={{margin:"10px 22px 0",background:"var(--mist)",borderRadius:12,
                     padding:"10px 13px",fontSize:12,textAlign:"left",border:"1px solid var(--sand)"}}>
          <div style={{fontWeight:700,color:"var(--forest)",marginBottom:3}}>📍 Delivering to</div>
          <div style={{color:"#555"}}>{deliveryAddress.text}</div>
          {deliveryAddress.w3w && (
            <div style={{color:"#9b59b6",fontWeight:700,marginTop:3}}>
              🟪 {deliveryAddress.w3w}
            </div>
          )}
        </div>
      )}

      {/* ── TRA VFD Fiscal Receipt (Tanzania only) ── */}
      {country === "TZ" && (
        <div className="vfd-receipt">
          <div className="vfd-badge">🏛️ TRA Fiscal Receipt</div>
          {vfd === "loading" && (
            <div className="vfd-pending">
              <div className="spinner" style={{width:16,height:16,borderWidth:2}}/>
              Generating fiscal receipt...
            </div>
          )}
          {vfd === "error" && (
            <div className="vfd-error">
              ⚠️ Receipt generation failed — our team has been notified. Your transaction ref <strong>{refNum}</strong> is valid.
            </div>
          )}
          {vfd && vfd !== "loading" && vfd !== "error" && (
            <>
              <div className="vfd-title">Official Tax Receipt · Tanzania</div>
              {[
                ["Business",    vfd.businessName],
                ["TIN",         vfd.tin],
                ["VRN",         vfd.vrn],
                ["Receipt No.", vfd.receiptNumber],
                ["Fiscal No.",  vfd.fiscalNumber],
                ["Amount",      `TZS ${vfd.amount?.toLocaleString()}`],
                ["VAT (18%)",   `TZS ${vfd.vat?.toLocaleString()}`],
                ["Issued",      new Date(vfd.issuedAt).toLocaleString("en-TZ")],
              ].map(([l, v]) => (
                <div key={l} className="vfd-row"><span>{l}</span><span>{v}</span></div>
              ))}
              <div className="vfd-qr">
                <QRCode data={vfd.qrData || vfd.fiscalNumber} size={63}/>
              </div>
              <div className="vfd-fn">Scan to verify at verify.tra.go.tz</div>
              <div className="vfd-fn" style={{marginTop:2}}>{vfd.fiscalNumber}</div>
              <div className="vfd-actions">
                <button className="vfd-btn print" onClick={() => window.print()}>🖨️ Print</button>
                <button className="vfd-btn share" onClick={() => {
                  const text = `Asiel Farm Shop\nReceipt: ${vfd.receiptNumber}\nFiscal: ${vfd.fiscalNumber}\nAmount: TZS ${vfd.amount?.toLocaleString()}\nVerify: ${vfd.qrUrl}
/* ── PWA Standalone mode adjustments ── */
@media (display-mode: standalone) {
  /* Extra breathing room below the status bar already handled by safe-area-inset-top on .nav */
  .app { padding-top:0; }
}

/* ── iOS momentum scrolling for all scrollable sections ── */
.oh-list, .ap-list, .market-grid-wrap, .cart-panel, .farmer-portal-wrap {
  -webkit-overflow-scrolling:touch;
  overscroll-behavior-y:contain;
}

/* ── Minimum 44×44px touch targets for all interactive elements ── */
.bn-item, .card-add, .fav-btn, .chip, .country-opt {
  min-height:44px; min-width:44px;
}
.chip, .country-opt { min-height:36px; }

/* ── Android ripple via CSS (works in Chrome/WebView) ── */
@supports (background: oklch(0 0 0)) {
  button, .card, .bn-item, .chip {
    position:relative; overflow:hidden;
  }
}

/* ── High-contrast / accessibility ── */
@media (forced-colors: active) {
  .badge-org, .badge-ver { border:1px solid ButtonText; }
}

/* ── Landscape phone — tighten spacing ── */
@media (max-height: 500px) and (orientation: landscape) {
  .nav { height:48px; }
  .bottom-nav { height:52px; }
  .hero { padding:16px; }
  .card-img { height:80px; font-size:36px; }
}
`;
                  if (navigator.share) navigator.share({ title: "TRA Receipt", text });
                  else navigator.clipboard?.writeText(text).then(() => alert("Receipt copied!"));
                }}>📤 Share</button>
              </div>
            </>
          )}
        </div>
      )}
      <div className="success-steps">
        {[["🧑‍🌾","Farmer notified","produce will be at the hub within 24 hrs"],["🔬","QC inspection","hub manager will green-light before dispatch"],["🚴","Last-mile delivery","rider assigned once QC cleared"],["⚖️","Final reconciliation","weight adjustments settled via "+(country==="TZ"?"Tigo Pesa":"M-Pesa")+" within 2 hrs"]].map(([icon,title,detail])=>(
          <div key={title} className="success-step">
            <div className="success-step-icon">{icon}</div>
            <div className="success-step-text"><strong>{title}</strong> — {detail}.</div>
          </div>
        ))}
      </div>
      <button className="success-close" onClick={() => { onSuccess(); onClose(); }}>🛒 Back to Shopping</button>
      <button
        onClick={() => generateInvoicePDF({
          refNum, totalTZS, cur, country,
          cart, qty, deliveryAddress, vfd, couponResult, loyaltyPts,
          paymentMethod: expressAnim
            ? `${expressAnim.charAt(0).toUpperCase()}${expressAnim.slice(1)} Pay`
            : (ALL_PAY_METHODS[method]?.name || method || "Payment"),
        })}
        style={{
          display:"flex", alignItems:"center", justifyContent:"center", gap:8,
          margin:"10px 22px 0", width:"calc(100% - 44px)",
          background:"white", border:"1.5px solid var(--forest)",
          color:"var(--forest)", borderRadius:12, padding:"11px",
          fontSize:13, fontWeight:700, cursor:"pointer",
          fontFamily:"var(--font-body)", transition:"all .18s",
        }}
        onMouseEnter={e => { e.currentTarget.style.background="var(--mist)"; }}
        onMouseLeave={e => { e.currentTarget.style.background="white"; }}
      >
        📄 Download Invoice PDF
      </button>
    </div>
  </div>
</div>

);

return (
<div className="pay-backdrop" onClick={e => e.target===e.currentTarget && onClose()}>
<div className="pay-sheet" ref={paySheetRef}>
<div className="pay-handle"/>
<div className="pay-header">
<div className="pay-header-icon">
<img src={LOGO_NAV} alt="Asiel Farms" style={{width:44,height:44,borderRadius:10,objectFit:"cover"}}/>
</div>
<div>
<div className="pay-header-title">Secure Checkout</div>
<div className="pay-header-sub">Asiel Farm Shop · Press Esc to close</div>
</div>
<button className="pay-close" onClick={onClose}>✕</button>
</div>
<div className="pay-summary">
<div>
<div className="pay-summary-label">Order Total</div>
<div className="pay-summary-amount">{displayAmt}</div>
{cur !== "TZS" && <div className="pay-summary-tzs">≈ {tzsAmt}</div>}
</div>
<div style={{textAlign:"right"}}>
<div className="pay-summary-items">Incl. hub & delivery</div>
<div style={{fontSize:11,color:"#bbb",marginTop:3}}>⚖️ Weight-adjusted on delivery</div>
</div>
</div>

    {/* ── Delivery address picker ── */}
    <AddressPicker
      country={country}
      value={deliveryAddress}
      onChange={addr => setDeliveryAddress(addr)}
    />

    <div className="pay-section-title">⚡ Express Pay</div>
    <div className="pay-express-row">
      <button className="pay-express-btn apple" onClick={() => handleExpress("apple")}>
        <div className="apple-logo-wrap"><span className="apple-symbol">🍎</span><span className="apple-text">Pay</span></div>
      </button>
      <button className="pay-express-btn google" onClick={() => handleExpress("google")}>
        <span className="gpay-logo"><span className="g">G</span><span className="o1">o</span><span className="o2">o</span><span className="g2">g</span><span className="le">le</span><span className="pay">Pay</span></span>
      </button>
    </div>
    <button className="pay-express-paypal" onClick={() => handleExpress("paypal")}>
      <span className="paypal-logo"><span className="pp">Pay</span><span className="pp2">Pal</span></span>
      <span style={{fontSize:12,fontWeight:500,opacity:.75}}>— fast, secure checkout</span>
    </button>

    <div className="pay-or"><div className="pay-or-line"/><div className="pay-or-text">or pay another way</div><div className="pay-or-line"/></div>

    <div className="pay-section-title">Payment Methods</div>
    <div className="pay-methods">
      {payMethods.map(m => (
        <div key={m.id} className={`pay-method${method===m.id?" selected":""}`} onClick={() => setMethod(method===m.id?null:m.id)}>
          <div className={`pay-method-icon ${m.cls}`}>{m.icon}</div>
          <div><div className="pay-method-name">{m.name}</div><div className="pay-method-sub">{m.sub}</div></div>
          <div className="pay-method-radio"/>
        </div>
      ))}
    </div>

    {method === "card" && (
      <div className="card-form">
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12}}>
          <div className="card-form-title">Card Details</div>
          <span style={{fontSize:13,fontWeight:800,color:"#635bff",letterSpacing:"-.5px"}}>stripe</span>
        </div>
        <div style={{display:"flex",gap:6,marginBottom:12,flexWrap:"wrap"}}>
          {[["VISA","#1a1f71","white"],["MC","#eb001b","#f79e1b"],["AMEX","#2e77bc","white"],["Discover","#ff6600","white"]].map(([n,bg,col])=>(
            <span key={n} style={{background:bg,color:col,borderRadius:5,padding:"2px 7px",fontSize:10,fontWeight:700}}>{n}</span>
          ))}
        </div>
        {API_BASE ? (
          <div className="cfield">
            <label>Card Details</label>
            <div style={{padding:"12px",border:"1.5px solid var(--sand)",borderRadius:10,background:"var(--mist)"}}>
              <CardElement
                options={{
                  style: {
                    base: { fontSize:"16px", color:"var(--text)", fontFamily:"var(--font-body)", "::placeholder":{ color:"#aaa" } },
                    invalid: { color:"#e53e3e" },
                  },
                  hidePostalCode: true,
                }}
                onChange={e => setCardError(e.error?.message || "")}
              />
            </div>
            {cardError && <div className="field-err" role="alert">⚠ {cardError}</div>}
          </div>
        ) : (
          <div style={{padding:"14px 12px",border:"1.5px dashed var(--sand)",borderRadius:10,background:"var(--mist)",fontSize:13,color:"#666",textAlign:"center"}}>
            <div style={{fontWeight:700,marginBottom:4}}>🧪 Demo Mode</div>
            <div>Card payments are simulated — no real card data needed.</div>
          </div>
        )}
        <div style={{fontSize:11,color:"#aaa",marginTop:8}}>🔒 Card data handled securely by Stripe. We never store raw card numbers.</div>
      </div>
    )}

    {MOBILE_MONEY_METHODS.includes(method) && method !== "card" && method !== "bank" && (
      <div className="momo-form">
        {method==="selcom" && (
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10,padding:"6px 10px",background:"#f0fff4",borderRadius:10}}>
            <span style={{fontSize:20}}>💚</span>
            <span style={{fontWeight:800,color:"#00a651",fontSize:15,letterSpacing:"-.5px"}}>Selcom</span>
            <span style={{fontWeight:600,fontSize:13,color:"#555"}}>Pay · Tanzania</span>
          </div>
        )}
        {method==="airtel" && (
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10,padding:"6px 10px",background:"#fff0f0",borderRadius:10}}>
            <span style={{fontSize:20}}>🔴</span>
            <span style={{fontWeight:800,color:"#e40000",fontSize:15,letterSpacing:"-.5px"}}>Airtel</span>
            <span style={{fontWeight:600,fontSize:13,color:"#555"}}>Money · {country==="KE"?"Kenya":"Tanzania"}</span>
          </div>
        )}
        {method==="mtn_momo" && (
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10,padding:"6px 10px",background:"#fffbe6",borderRadius:10}}>
            <span style={{fontSize:20}}>🟡</span>
            <span style={{fontWeight:800,color:"#f6a800",fontSize:15,letterSpacing:"-.5px"}}>MTN</span>
            <span style={{fontWeight:600,fontSize:13,color:"#555"}}>MoMo · {country}</span>
          </div>
        )}
        {method==="opay" && (
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10,padding:"6px 10px",background:"#fff4ec",borderRadius:10}}>
            <span style={{fontSize:20}}>🟠</span>
            <span style={{fontWeight:800,color:"#f47920",fontSize:15,letterSpacing:"-.5px"}}>OPay</span>
            <span style={{fontWeight:600,fontSize:13,color:"#555"}}>Digital Wallet · Nigeria</span>
          </div>
        )}
        <div className="momo-hint">
          Enter the number linked to your {
            method==="mpesa"    ? "M-Pesa"              :
            method==="tigopesa" ? "Tigo Pesa / Vodacom" :
            method==="selcom"   ? "Selcom Pay"          :
            method==="airtel"   ? "Airtel Money"        :
            method==="mtn_momo" ? "MTN MoMo"            :
                                  "OPay"
          } wallet. You'll receive a USSD push prompt.
        </div>
        <div className="momo-input-wrap">
          <span className="momo-flag">
            {method==="mpesa"                         ? "🇰🇪" :
             method==="airtel" && country==="KE"      ? "🇰🇪" :
             method==="mtn_momo" && country==="NG"    ? "🇳🇬" :
             method==="mtn_momo" && country==="GH"    ? "🇬🇭" :
             method==="mtn_momo" && country==="UG"    ? "🇺🇬" :
             method==="mtn_momo" && country==="RW"    ? "🇷🇼" :
             method==="opay"                          ? "🇳🇬" : "🇹🇿"}
          </span>
          <input
            placeholder={
              method==="mpesa" || (method==="airtel" && country==="KE")
                ? "+254 7XX XXX XXX"
                : method==="mtn_momo" && country==="NG" || method==="opay"
                ? "+234 8XX XXX XXXX"
                : method==="mtn_momo" && country==="GH"
                ? "+233 2XX XXX XXX"
                : method==="mtn_momo" && country==="UG"
                ? "+256 7XX XXX XXX"
                : method==="mtn_momo" && country==="RW"
                ? "+250 7XX XXX XXX"
                : "+255 7XX XXX XXX"
            }
            value={phone} type="tel"
            style={phoneError ? {borderColor:"#c0392b"} : {}}
            onChange={e => {
              const val = e.target.value;
              setPhone(val);
              // Clear error as user types; revalidate once ≥7 digits entered
              if (phoneError) {
                const digits = val.replace(/\D/g,"");
                if (digits.length >= 7) {
                  const { error } = validatePhone(val);
                  setPhoneError(error);
                } else {
                  setPhoneError("");
                }
              }
            }}
            onBlur={() => {
              // Validate on blur so user isn't interrupted while typing
              if (phone.replace(/\D/g,"").length > 0) {
                const { error } = validatePhone(phone);
                setPhoneError(error);
              }
            }}
          />
        </div>
        {phoneError && (
          <div style={{fontSize:11,color:"#c0392b",background:"#fff0f0",borderRadius:8,
                       padding:"6px 10px",marginTop:6,display:"flex",gap:6,alignItems:"flex-start"}}>
            ⚠️ {phoneError}
          </div>
        )}
        {!phoneError && phone && validatePhone(phone).valid && (
          <div style={{fontSize:11,color:"#27ae60",background:"#f0fff4",borderRadius:8,
                       padding:"6px 10px",marginTop:6}}>
            ✅ Valid number · will be sent as {validatePhone(phone).e164}
          </div>
        )}
        {method==="selcom" && (
          <div style={{fontSize:11,color:"#00a651",background:"#f0fff4",borderRadius:8,padding:"7px 10px",marginTop:6}}>
            💚 You'll get an SMS + USSD popup. Enter your 4-digit Selcom PIN to confirm. Powered by Selcom Wireless Tanzania.
          </div>
        )}
        {method==="airtel" && (
          <div style={{fontSize:11,color:"#c0392b",background:"#fff0f0",borderRadius:8,padding:"7px 10px",marginTop:6}}>
            🔴 A USSD prompt will appear. Confirm with your Airtel Money PIN. Available across Tanzania &amp; Kenya.
          </div>
        )}
        {method==="mtn_momo" && (
          <div style={{fontSize:11,color:"#b8860b",background:"#fffbe6",borderRadius:8,padding:"7px 10px",marginTop:6}}>
            🟡 A USSD push will be sent to your MTN line. Enter your MoMo PIN to approve. MTN MoMo is available in 9 African countries.
          </div>
        )}
        <div className="momo-push-note"><span className="ni">📲</span><span>A push notification will be sent. Enter your PIN to confirm. Never share your PIN.</span></div>
      </div>
    )}

    {method==="bank" && (
      <div className="bank-form">
        <div style={{fontWeight:600,fontSize:13,color:"var(--forest)",marginBottom:12}}>Transfer to Asiel Farm Shop Escrow</div>
        {[["Bank",country==="TZ"?"CRDB Bank Tanzania":"KCB Kenya"],["Account Name","Asiel Farm Shop Ltd"],["Account No.",country==="TZ"?"0150-123456-00":"1234567890"],["Swift",country==="TZ"?"CRDBTZTZ":"KCBLKENX"],["Reference",refNum],["Amount (TZS)",`TZS ${totalTZS.toLocaleString()}`]].map(([l,v])=>(
          <div key={l} className="bank-detail-row"><span className="bank-detail-label">{l}</span><span className="bank-detail-value">{v}</span></div>
        ))}
      </div>
    )}

    {method && (
      <button className="pay-confirm-btn" onClick={handlePay}>
        🔒 Pay {displayAmt}{cur!=="TZS"&&<span style={{opacity:.7,fontSize:12}}>≈ {tzsAmt}</span>}
      </button>
    )}

    <div className="pay-security">
      {[["🔒","SSL Encrypted"],["🛡️","PCI DSS"],["✅","3D Secure"],["🏦","Escrow Protected"]].map(([i,l])=>(
        <div key={l} className="pay-sec-badge"><span>{i}</span>{l}</div>
      ))}
    </div>
    <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:14,padding:"0 22px 20px",flexWrap:"wrap"}}>
      <span style={{fontSize:12,fontWeight:800,color:"#635bff"}}>stripe</span>
      <span style={{fontSize:11,fontWeight:900,fontStyle:"italic",color:"#003087"}}>Pay<span style={{color:"#009cde"}}>Pal</span></span>
      <span style={{fontSize:11,fontWeight:800,color:"#000"}}> Pay</span>
      <span style={{fontSize:10,color:"#ccc"}}>Powered by Asiel Farm Shop Payments</span>
    </div>
  </div>
</div>

);
}

// ─── FarmerOnboarding — 7-step profile wizard shown before farmer portal ─────────────
//
// Status lifecycle:
//   null / undefined  → show wizard
//   "pending"         → show "under review" screen
//   "approved"        → onboarding complete, farmer portal unlocked
//   "rejected"        → show rejection reason + restart option
//
// Progress is saved to localStorage after every step so the farmer can
// resume where they left off if they close the app mid-way.
//
function FarmerOnboarding({ country, onApproved }) {
const { t, lang } = useTranslation();

const DRAFT_KEY   = "asf_farmer_draft";
const STATUS_KEY  = "asf_farmer_status";

const loadDraft = () => {
  try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || "null"); } catch { return null; }
};

const [step, setStep] = useState(() => loadDraft()?.step ?? 0);
const [profile, setProfile] = useState(() => loadDraft()?.profile ?? {
  fullName: "", nationalId: "", farmName: "", region: "",
  farmSize: "", lat: null, lng: null,
  crops: [], farmingMethod: "conventional", yearRound: true,
  canHubDeliver: null, hasColdStorage: null, maxWeeklyKg: "",
  payoutMethod: "", payoutPhone: "",
});
const [status, setStatus]   = useState(() => {
  try { return localStorage.getItem(STATUS_KEY) || null; } catch { return null; }
});
const [errs,    setErrs]    = useState({});
const [geoLoading, setGeoLoading] = useState(false);
const [submitting, setSubmitting] = useState(false);

const regions = country === "KE" ? KE_COUNTIES : TZ_REGIONS;
const payoutMethods = OB_PAYOUT_METHODS.filter(m => m.countries.includes(country));

// Persist draft on every change
useEffect(() => {
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ step, profile })); } catch { /* quota */ }
}, [step, profile]);

function set(key, val) {
  setProfile(p => ({ ...p, [key]: val }));
  setErrs(e => ({ ...e, [key]: "" }));
}

function toggleCrop(crop) {
  setProfile(p => ({
    ...p,
    crops: p.crops.includes(crop) ? p.crops.filter(c => c !== crop) : [...p.crops, crop],
  }));
  setErrs(e => ({ ...e, crops: "" }));
}

// Per-step validation
function validate(s) {
  const e = {};
  if (s === 1) {
    if (profile.fullName.trim().length < 2)       e.fullName  = "Full name is required";
    if (!/^\d{8,20}$/.test(profile.nationalId.replace(/\s/g,"")))
                                                   e.nationalId = "Enter a valid ID number (digits only)";
  }
  if (s === 2) {
    if (profile.farmName.trim().length < 2)        e.farmName = "Farm name is required";
    if (!profile.region)                           e.region   = "Please select your region";
    if (!profile.farmSize)                         e.farmSize = "Please select a farm size";
  }
  if (s === 4) {
    if (profile.crops.length === 0)                e.crops    = "Select at least one crop";
  }
  if (s === 5) {
    if (!profile.maxWeeklyKg || isNaN(Number(profile.maxWeeklyKg)) || Number(profile.maxWeeklyKg) <= 0)
                                                   e.maxWeeklyKg = "Enter a valid weekly supply in KG";
    if (profile.canHubDeliver === null)            e.canHubDeliver = "Please answer this question";
    if (profile.hasColdStorage === null)           e.hasColdStorage = "Please answer this question";
  }
  if (s === 6) {
    if (!profile.payoutMethod)                     e.payoutMethod = "Select a payout method";
    if (profile.payoutMethod !== "bank" && profile.payoutPhone.trim().length < 9)
                                                   e.payoutPhone  = "Enter a valid mobile number";
  }
  return e;
}

function next() {
  if (step === 0) { setStep(1); return; }
  const e = validate(step);
  if (Object.keys(e).length) { setErrs(e); return; }
  if (step < OB_TOTAL_STEPS) { setStep(s => s + 1); }
}

function back() { if (step > 1) setStep(s => s - 1); }

function detectLocation() {
  if (!navigator.geolocation) return;
  setGeoLoading(true);
  let cancelled = false;
  navigator.geolocation.getCurrentPosition(
    pos => {
      if (cancelled) return;
      set("lat", parseFloat(pos.coords.latitude.toFixed(5)));
      set("lng", parseFloat(pos.coords.longitude.toFixed(5)));
      setGeoLoading(false);
      next(); // auto-advance to next step on success
    },
    () => { if (!cancelled) setGeoLoading(false); },
    { timeout: 8000 }
  );
  // Cleanup: mark cancelled if component unmounts before GPS resolves
  return () => { cancelled = true; };
}

async function submit() {
  const e = validate(6);
  if (Object.keys(e).length) { setErrs(e); return; }
  setSubmitting(true);
  try {
    if (API_BASE) {
      try {
        await apiFetch("/api/farmers/profile", { method: "POST", body: JSON.stringify(profile) });
      } catch (err) {
        log.warn("[FarmerOnboarding] Profile API call failed:", err.message);
      }
    }
    const newStatus = API_BASE ? "pending" : "approved"; // demo: auto-approve
    try {
      localStorage.setItem(STATUS_KEY, newStatus);
      localStorage.removeItem(DRAFT_KEY); // clear draft after submission
    } catch { /* quota */ }
    setStatus(newStatus);
    if (!API_BASE) setTimeout(onApproved, 1200); // demo: brief success flash then unlock
  } finally {
    setSubmitting(false);
  }
}

// ── Status screens ──────────────────────────────────────────────────────────
if (status === "pending") return (
  <div className="ob-status-wrap">
    <div className="ob-status-card">
      <div className="ob-status-icon">⏳</div>
      <div className="ob-status-title">{t("ob.pending_title")}</div>
      <div className="ob-status-sub">{t("ob.pending_sub")}</div>
      <div className="ob-status-hint">Reference: {profile.nationalId || "—"}</div>
    </div>
  </div>
);

if (status === "approved") return (
  <div className="ob-status-wrap">
    <div className="ob-status-card" style={{borderColor:"var(--leaf)"}}>
      <div className="ob-status-icon">🎉</div>
      <div className="ob-status-title">{t("ob.approved_title")}</div>
      <div className="ob-status-sub">{t("ob.approved_sub")}</div>
      <button className="ob-btn-primary" style={{marginTop:24}} onClick={onApproved}>{t("ob.start_listing")}</button>
    </div>
  </div>
);

// ── Progress bar ────────────────────────────────────────────────────────────
const pct = step === 0 ? 0 : Math.round((step / OB_TOTAL_STEPS) * 100);

// ── Review summary rows ─────────────────────────────────────────────────────
const reviewRows = [
  ["Identity",  `${profile.fullName} · ID ${profile.nationalId}`],
  ["Farm",      `${profile.farmName} · ${profile.region} · ${profile.farmSize}`],
  ["Location",  profile.lat ? `${profile.lat}, ${profile.lng}` : "Not set"],
  ["Crops",     profile.crops.slice(0,4).join(", ") + (profile.crops.length > 4 ? ` +${profile.crops.length-4}` : "")],
  ["Method",    profile.farmingMethod + " · " + (profile.yearRound ? "Year-round" : "Seasonal")],
  ["Logistics", `Hub: ${profile.canHubDeliver?"Yes":"No"} · Cold: ${profile.hasColdStorage?"Yes":"No"} · ${profile.maxWeeklyKg} KG/wk`],
  ["Payout",    `${profile.payoutMethod}${profile.payoutPhone ? " · " + profile.payoutPhone : ""}`],
];

return (
  <div className="ob-wrap">
    {/* Header */}
    <div className="ob-header">
      <div className="ob-header-brand">🌱 Asiel Farm Shop</div>
      {step > 0 && (
        <div className="ob-progress-label">
          {t("ob.progress").replace("{n}", step).replace("{total}", OB_TOTAL_STEPS)}
        </div>
      )}
    </div>

    {/* Progress bar */}
    {step > 0 && (
      <div className="ob-progress-track"
        role="progressbar"
        aria-valuenow={step}
        aria-valuemin={1}
        aria-valuemax={OB_TOTAL_STEPS}
        aria-label={`Step ${step} of ${OB_TOTAL_STEPS}`}>
        <div className="ob-progress-fill" style={{width:`${pct}%`}}/>
      </div>
    )}

    <div className="ob-body">

      {/* ── Step 0: Welcome ────────────────────────────────────────────── */}
      {step === 0 && (
        <div className="ob-step ob-welcome">
          <div className="ob-welcome-icon">🌾</div>
          <h2 className="ob-step-title">{t("ob.s0.title")}</h2>
          <p className="ob-step-sub">{t("ob.s0.sub")}</p>
          <div className="ob-step-checklist">
            {[["👤","Identity & farm name"],["📍","Farm location"],["🌿","Crops you grow"],["🚐","Delivery capacity"],["💰","Payout details"]].map(([icon, label]) => (
              <div key={label} className="ob-check-row"><span>{icon}</span><span>{label}</span></div>
            ))}
          </div>
          <button className="ob-btn-primary ob-welcome-btn" onClick={next}>{t("ob.s0.begin")}</button>
        </div>
      )}

      {/* ── Step 1: Identity ───────────────────────────────────────────── */}
      {step === 1 && (
        <div className="ob-step">
          <h2 className="ob-step-title">{t("ob.s1.title")}</h2>
          <div className="ob-field">
            <label>{t("ob.s1.name")} *</label>
            <input value={profile.fullName} placeholder={t("ob.s1.name_ph")}
              className={errs.fullName ? "ob-err-input" : ""}
              onChange={e => set("fullName", e.target.value)}/>
            {errs.fullName && <div className="ob-field-err" role="alert">{errs.fullName}</div>}
          </div>
          <div className="ob-field">
            <label>{t("ob.s1.id")} *</label>
            <input value={profile.nationalId} placeholder={t("ob.s1.id_ph")}
              inputMode="numeric"
              className={errs.nationalId ? "ob-err-input" : ""}
              onChange={e => set("nationalId", e.target.value.replace(/[^\d\s]/g,""))}/>
            {errs.nationalId && <div className="ob-field-err" role="alert">{errs.nationalId}</div>}
            <div className="ob-field-hint">
              {country === "TZ" ? "20-digit NIDA number" : "7–8 digit Kenya National ID"}
            </div>
          </div>
        </div>
      )}

      {/* ── Step 2: Farm details ────────────────────────────────────────── */}
      {step === 2 && (
        <div className="ob-step">
          <h2 className="ob-step-title">{t("ob.s2.title")}</h2>
          <div className="ob-field">
            <label>{t("ob.s2.farm_name")} *</label>
            <input value={profile.farmName} placeholder={t("ob.s2.farm_name_ph")}
              className={errs.farmName ? "ob-err-input" : ""}
              onChange={e => set("farmName", e.target.value)}/>
            {errs.farmName && <div className="ob-field-err" role="alert">{errs.farmName}</div>}
          </div>
          <div className="ob-field">
            <label>{t("ob.s2.region")} *</label>
            <select value={profile.region}
              className={errs.region ? "ob-err-input" : ""}
              onChange={e => set("region", e.target.value)}>
              <option value="">{t("ob.s2.region_ph")}</option>
              {regions.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
            {errs.region && <div className="ob-field-err" role="alert">{errs.region}</div>}
          </div>
          <div className="ob-field">
            <label>{t("ob.s2.size")} *</label>
            <div className="ob-size-grid">
              {FARM_SIZES.map(s => (
                <button key={s.id}
                  className={`ob-size-card${profile.farmSize === s.id ? " selected" : ""}`}
                  onClick={() => set("farmSize", s.id)}>
                  <div className="ob-size-label">{lang === "sw" ? s.labelSw : s.label}</div>
                  <div className="ob-size-sub">{s.sub}</div>
                </button>
              ))}
            </div>
            {errs.farmSize && <div className="ob-field-err" role="alert">{errs.farmSize}</div>}
          </div>
        </div>
      )}

      {/* ── Step 3: Location ────────────────────────────────────────────── */}
      {step === 3 && (
        <div className="ob-step">
          <h2 className="ob-step-title">{t("ob.s3.title")}</h2>
          <p className="ob-step-sub">{t("ob.s3.sub")}</p>
          {profile.lat ? (
            <div className="ob-location-set">
              <div className="ob-location-icon">📍</div>
              <div>
                <div className="ob-location-coords">{profile.lat}, {profile.lng}</div>
                <div className="ob-location-sub">Location detected</div>
              </div>
              <button className="ob-location-reset" onClick={() => { set("lat",null); set("lng",null); }}>✕</button>
            </div>
          ) : (
            <button className="ob-btn-secondary" disabled={geoLoading} onClick={detectLocation}>
              {geoLoading ? t("ob.detecting") : t("ob.detect_btn")}
            </button>
          )}
          <button className="ob-skip-link" onClick={next}>{t("ob.skip_location")}</button>
        </div>
      )}

      {/* ── Step 4: Crops & method ──────────────────────────────────────── */}
      {step === 4 && (
        <div className="ob-step">
          <h2 className="ob-step-title">{t("ob.s4.title")}</h2>
          <p className="ob-step-sub">{t("ob.s4.sub")}</p>
          {errs.crops && <div className="ob-field-err" role="alert" style={{marginBottom:8}}>{errs.crops}</div>}
          <div className="ob-crop-grid">
            {CROPS_LIST.map(crop => (
              <button key={crop}
                className={`ob-crop-chip${profile.crops.includes(crop) ? " selected" : ""}`}
                onClick={() => toggleCrop(crop)}>
                {crop}
              </button>
            ))}
          </div>
          <div className="ob-field" style={{marginTop:20}}>
            <label>{t("ob.s4.method")}</label>
            <div className="ob-radio-group">
              {[["organic",t("ob.s4.organic")],["conventional",t("ob.s4.conventional")],["mixed",t("ob.s4.mixed")]].map(([val,label]) => (
                <label key={val} className={`ob-radio-opt${profile.farmingMethod===val?" selected":""}`}>
                  <input type="radio" name="method" value={val}
                    checked={profile.farmingMethod === val}
                    onChange={() => set("farmingMethod", val)}/>
                  {label}
                </label>
              ))}
            </div>
          </div>
          <div className="ob-field">
            <label>{t("ob.s4.year_round")}</label>
            <div className="ob-radio-group">
              {[[true,t("ob.s4.yes")],[false,t("ob.s4.no")]].map(([val,label]) => (
                <label key={String(val)} className={`ob-radio-opt${profile.yearRound===val?" selected":""}`}>
                  <input type="radio" name="yearRound"
                    checked={profile.yearRound === val}
                    onChange={() => set("yearRound", val)}/>
                  {label}
                </label>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── Step 5: Logistics ────────────────────────────────────────────── */}
      {step === 5 && (
        <div className="ob-step">
          <h2 className="ob-step-title">{t("ob.s5.title")}</h2>
          <div className="ob-field">
            <label>{t("ob.s5.hub")} *</label>
            <div className="ob-yn-row">
              {[[true,"Yes / Ndiyo"],[false,"No / Hapana"]].map(([val,label]) => (
                <button key={String(val)}
                  className={`ob-yn-btn${profile.canHubDeliver===val?" selected":""}`}
                  onClick={() => { setProfile(p=>({...p,canHubDeliver:val})); setErrs(e=>({...e,canHubDeliver:""})); }}>
                  {label}
                </button>
              ))}
            </div>
            {errs.canHubDeliver && <div className="ob-field-err" role="alert">{errs.canHubDeliver}</div>}
          </div>
          <div className="ob-field">
            <label>{t("ob.s5.cold")} *</label>
            <div className="ob-yn-row">
              {[[true,"Yes / Ndiyo"],[false,"No / Hapana"]].map(([val,label]) => (
                <button key={String(val)}
                  className={`ob-yn-btn${profile.hasColdStorage===val?" selected":""}`}
                  onClick={() => { setProfile(p=>({...p,hasColdStorage:val})); setErrs(e=>({...e,hasColdStorage:""})); }}>
                  {label}
                </button>
              ))}
            </div>
            {errs.hasColdStorage && <div className="ob-field-err" role="alert">{errs.hasColdStorage}</div>}
          </div>
          <div className="ob-field">
            <label>{t("ob.s5.max_kg")} *</label>
            <div className="ob-input-row">
              <input type="number" min="1" value={profile.maxWeeklyKg} placeholder={t("ob.s5.max_kg_ph")}
                className={errs.maxWeeklyKg ? "ob-err-input" : ""}
                onChange={e => set("maxWeeklyKg", e.target.value)}/>
              <span className="ob-input-unit">KG / week</span>
            </div>
            {errs.maxWeeklyKg && <div className="ob-field-err" role="alert">{errs.maxWeeklyKg}</div>}
          </div>
        </div>
      )}

      {/* ── Step 6: Payout details ──────────────────────────────────────── */}
      {step === 6 && (
        <div className="ob-step">
          <h2 className="ob-step-title">{t("ob.s6.title")}</h2>
          <p className="ob-step-sub">{t("ob.s6.sub")}</p>
          <div className="ob-field">
            <label>{t("ob.s6.method")} *</label>
            <div className="ob-payout-grid">
              {payoutMethods.map(m => (
                <button key={m.id}
                  className={`ob-payout-card${profile.payoutMethod===m.id?" selected":""}`}
                  onClick={() => { set("payoutMethod",m.id); }}>
                  <span className="ob-payout-icon">{m.icon}</span>
                  <span className="ob-payout-label">{m.label}</span>
                </button>
              ))}
            </div>
            {errs.payoutMethod && <div className="ob-field-err" role="alert">{errs.payoutMethod}</div>}
          </div>
          {profile.payoutMethod && profile.payoutMethod !== "bank" && (
            <div className="ob-field">
              <label>{t("ob.s6.phone")} *</label>
              <input type="tel" value={profile.payoutPhone} placeholder={t("ob.s6.phone_ph")}
                className={errs.payoutPhone ? "ob-err-input" : ""}
                onChange={e => set("payoutPhone", e.target.value)}/>
              {errs.payoutPhone && <div className="ob-field-err" role="alert">{errs.payoutPhone}</div>}
            </div>
          )}
          {profile.payoutMethod === "bank" && (
            <div className="ob-bank-note">{t("ob.s6.bank_note")}</div>
          )}
        </div>
      )}

      {/* ── Step 7: Review & submit ─────────────────────────────────────── */}
      {step === 7 && (
        <div className="ob-step">
          <h2 className="ob-step-title">{t("ob.s7.title")}</h2>
          <p className="ob-step-sub">{t("ob.s7.sub")}</p>
          <div className="ob-review-list">
            {reviewRows.map(([label, value], idx) => (
              <div key={label} className="ob-review-row">
                <div className="ob-review-label">{label}</div>
                <div className="ob-review-value">{value || "—"}</div>
                <button className="ob-review-edit" aria-label={`${t("ob.s7.edit")} ${label}`} onClick={() => setStep(Math.min(idx + 1, OB_TOTAL_STEPS - 1))}>{t("ob.s7.edit")}</button>
              </div>
            ))}
          </div>
          <button className="ob-btn-primary" disabled={submitting} onClick={submit} style={{marginTop:24,width:"100%"}}>
            {submitting ? "Submitting…" : t("ob.submit")}
          </button>
        </div>
      )}

    </div>

    {/* Navigation buttons */}
    {step > 0 && (
      <div className="ob-nav">
        {step > 1 && <button className="ob-btn-ghost" onClick={back}>{t("ob.back")}</button>}
        {step < OB_TOTAL_STEPS && (
          <button className="ob-btn-primary ob-nav-next" onClick={next}>{t("ob.next")}</button>
        )}
      </div>
    )}
  </div>
);
}

// ─── ErrorBoundary ───────────────────────────────────────────────────────────────────
// Catches any uncaught JavaScript error in the component tree and shows a
// graceful fallback instead of a blank white screen.
//// Catches any uncaught JavaScript error in the component tree and shows a
// graceful fallback. Errors are reported to Sentry and PostHog via analytics.
//
class ErrorBoundary extends React.Component {
constructor(props) {
super(props);
this.state = { hasError: false, error: null, errorId: null };
}

static getDerivedStateFromError(error) {
const errorId = "ERR-" + Date.now().toString(36).toUpperCase();
return { hasError: true, error, errorId };
}

componentDidCatch(error, info) {
// Send to Sentry + backend error log via analytics service (Issue 18)
analytics.captureException(error, {
errorId:        this.state.errorId,
componentStack: info?.componentStack,
url:            window.location.href,
});
}

handleReset() {
// Clear error state and let React retry rendering
this.setState({ hasError: false, error: null, errorId: null });
}

handleReload() {
window.location.reload();
}

render() {
if (!this.state.hasError) return this.props.children;

const { error, errorId } = this.state;
const isDev = !API_BASE; // show stack trace only in demo / dev mode

return (
  <div className="eb-wrap">
    <div className="eb-card">
      <div className="eb-icon">⚠️</div>
      <div className="eb-title">Something went wrong</div>
      <div className="eb-sub">
        Asiel Farm Shop hit an unexpected error. Our team has been
        notified. Your cart and data are safe — please refresh and try again.
      </div>
      {errorId && (
        <div className="eb-ref">Error ID: {errorId}</div>
      )}
      {isDev && error?.message && (
        <div className="eb-detail">{error.message}</div>
      )}
      <button className="eb-btn primary" onClick={() => this.handleReset()}>
        🔄 Try Again
      </button>
      <button className="eb-btn secondary" onClick={() => this.handleReload()}>
        ↺ Reload App
      </button>
      <div style={{ fontSize:11, color:"#bbb", marginTop:8 }}>
        If this keeps happening, contact support@asielfarm.tz
      </div>
    </div>
  </div>
);

}
}

// ─── Shimmer skeleton (module-level — stable reference, not re-created on every App render) ──
const ShimmerGrid = React.memo(function ShimmerGrid() {
return (
<div className="tab-shimmer" aria-busy="true" aria-label="Loading products...">
{[1,2,3,4].map(i => (
<div key={i} className="shimmer-card">
<div className="shimmer shimmer-img"/>
<div className="shimmer shimmer-line" style={{margin:"10px 12px 6px"}}/>
<div className="shimmer shimmer-line short" style={{margin:"0 12px 14px"}}/>
</div>
))}
</div>
);
});
ShimmerGrid.displayName = "ShimmerGrid";

// ─── useVoice hook — Web Speech API with Swahili / English support ────────────────────
// lang: BCP-47 tag e.g. "sw-TZ" or "en-KE". Returns { listening, supported, start, stop }.
// onResult(transcript) is called once recognition produces a final result.
function useVoice(lang, onResult) {
  const [listening, setListening] = React.useState(false);
  const srRef = React.useRef(null);
  const supported = typeof window !== "undefined" &&
    ("SpeechRecognition" in window || "webkitSpeechRecognition" in window);

  const start = React.useCallback(() => {
    if (!supported || listening) return;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const sr = new SR();
    sr.lang = lang;
    sr.continuous = false;
    sr.interimResults = false;
    sr.onstart  = () => setListening(true);
    sr.onend    = () => setListening(false);
    sr.onerror  = () => setListening(false);
    sr.onresult = e => {
      const transcript = Array.from(e.results)
        .map(r => r[0].transcript).join(" ").trim();
      if (transcript) onResult(transcript);
    };
    srRef.current = sr;
    sr.start();
  }, [lang, listening, onResult, supported]);

  const stop = React.useCallback(() => {
    srRef.current?.stop();
    setListening(false);
  }, []);

  // Cleanup on unmount
  React.useEffect(() => () => { srRef.current?.stop(); }, []);

  return { listening, supported, start, stop };
}

// ─── VoiceMic — mic button that toggles listening ─────────────────────────────────────
function VoiceMic({ lang, onResult, title }) {
  const { listening, supported, start, stop } = useVoice(lang, onResult);
  return (
    <button
      type="button"
      className={`voice-btn${listening ? " listening" : ""}${!supported ? " unsupported" : ""}`}
      aria-label={listening ? "Stop voice input" : (title || "Start voice input")}
      aria-pressed={listening}
      title={!supported ? "Voice input not supported in this browser" : (title || "Voice input")}
      onClick={listening ? stop : start}
      disabled={!supported}
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
        <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
        <line x1="12" y1="19" x2="12" y2="23"/>
        <line x1="8" y1="23" x2="16" y2="23"/>
      </svg>
    </button>
  );
}

// ─── Delivery ETA helper ─────────────────────────────────────────────────────────────
// Estimates an arrival window based on distance and current hour.
// Hub collection adds ~30 min; rider speed ~25 km/h on average East African roads.
function calcETA(distStr) {
  const km = parseFloat(distStr) || 0;
  const rideMin = Math.round((km / 25) * 60);
  const totalMin = 30 + rideMin;  // hub + ride
  const now = new Date();
  const arrivalMs = now.getTime() + totalMin * 60000;
  const arrival = new Date(arrivalMs);
  const hh = arrival.getHours();
  const mm = String(arrival.getMinutes()).padStart(2, "0");
  const period = hh >= 12 ? "PM" : "AM";
  const h12 = hh % 12 || 12;
  // Cut-off: orders placed after 2 PM arrive next morning
  if (now.getHours() >= 14) return "Tomorrow 8–10 AM";
  return `Delivers by ${h12}:${mm} ${period} today`;
}

// ─── Price comparison widget helpers ────────────────────────────────────────────────
const MARKET_NAME = { TZ: "Kariakoo", KE: "Gikomba", default: "local market" };
function PriceCompare({ product, cur, country }) {
  if (!product.marketPrice || product.marketPrice <= product.tzsPrice) return null;
  const saveTZS = product.marketPrice - product.tzsPrice;
  const savePct = Math.round((saveTZS / product.marketPrice) * 100);
  const market  = MARKET_NAME[country] || MARKET_NAME.default;
  return (
    <div className="price-compare">
      <span className="price-compare-icon">🏷️</span>
      <div>
        <div className="price-compare-save">Save {fmt(saveTZS, cur)}/{product.unit} ({savePct}% off)</div>
        <div className="price-compare-vs">vs {market} market price of {fmt(product.marketPrice, cur)}</div>
      </div>
    </div>
  );
}

// ─── Chama group buying ──────────────────────────────────────────────────────────────
// Creates a shareable group-order session. All members add items; one member checks out.
// In demo mode: session lives in localStorage; production uses /api/group-orders/:id.
function useChamaSession() {
  const [session, setSession] = React.useState(() => {
    try {
      const raw = sessionStorage.getItem("asf_chama");
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  });

  const createSession = React.useCallback((cart) => {
    const id = secureId();
    const s = { id, creatorCart: cart, members: [{ name: "You (organiser)", items: cart.length }], createdAt: Date.now() };
    try { sessionStorage.setItem("asf_chama", JSON.stringify(s)); } catch {}
    setSession(s);
    return s;
  }, []);

  const clearSession = React.useCallback(() => {
    try { sessionStorage.removeItem("asf_chama"); } catch {}
    setSession(null);
  }, []);

  return { session, createSession, clearSession };
}

function ChamaSheet({ cart, cur, country, onClose, onCheckout, showToast }) {
  const { session, createSession } = useChamaSession();
  const [copied, setCopied] = React.useState(false);

  const activeSession = React.useRef(session || createSession(cart)).current;
  const shareUrl = `${window.location.origin}/?chama=${activeSession.id}`;

  const copyLink = React.useCallback(async () => {
    try { await navigator.clipboard.writeText(shareUrl); } catch {}
    setCopied(true);
    showToast("Group order link copied! 🤝");
    setTimeout(() => setCopied(false), 2000);
  }, [shareUrl, showToast]);

  const shareWA = React.useCallback(() => {
    const msg = encodeURIComponent(
      `Jiunge nami kwenye order ya pamoja (Chama) ya Asiel Farm Shop! Bonyeza link hii uongeze vitu vyako: ${shareUrl}`
    );
    window.open(`https://wa.me/?text=${msg}`, "_blank", "noopener");
  }, [shareUrl]);

  const totalTZS = cart.reduce((s, p) => s + p.tzsPrice, 0);
  const DEMO_MEMBERS = [
    { name: "You (organiser)", items: cart.length },
    { name: "Amina Saleh", items: 3 },
    { name: "Grace Wanjiku", items: 2 },
  ];

  return (
    <div className="chama-overlay" role="dialog" aria-modal="true" aria-label="Group order">
      <div className="chama-sheet">
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:4}}>
          <div className="chama-title">🤝 Chama Group Order</div>
          <button onClick={onClose} style={{background:"none",border:"none",fontSize:22,cursor:"pointer",color:"#aaa",padding:0}}>✕</button>
        </div>
        <div className="chama-sub">
          Share the link below — when everyone has added their items, one person checks out and pays together. Great for women's savings groups!
        </div>
        <div className="chama-link-box">
          <div className="chama-link-text">{shareUrl}</div>
          <button className="chama-copy-btn" onClick={copyLink}>{copied ? "Copied!" : "Copy"}</button>
        </div>
        <button className="ref-share-btn" style={{marginBottom:14}} onClick={shareWA}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.570-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.890-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413Z"/></svg>
          Invite via WhatsApp
        </button>
        <div style={{fontWeight:700,fontSize:12,color:"#888",marginBottom:8}}>👥 Members ({DEMO_MEMBERS.length})</div>
        <div className="chama-member-list">
          {DEMO_MEMBERS.map((m, i) => (
            <div key={i} className="chama-member">
              <span className="chama-member-av">{["🧑‍🌾","👩","👩‍💼"][i] || "👤"}</span>
              <span className="chama-member-name">{m.name}</span>
              <span className="chama-member-items">{m.items} item{m.items !== 1 ? "s" : ""}</span>
            </div>
          ))}
        </div>
        <div style={{fontWeight:700,fontSize:14,marginBottom:10}}>
          Group total: <strong style={{color:"var(--forest)"}}>{fmt(totalTZS + 43200, cur)}</strong>
        </div>
        <button className="chama-checkout-btn" onClick={onCheckout}>🔒 Group Checkout</button>
      </div>
    </div>
  );
}

// ─── Recently viewed tracker ─────────────────────────────────────────────────────────
const MAX_RECENT = 6;
function useRecentlyViewed() {
  const [recent, setRecent] = React.useState(() => {
    try { return JSON.parse(localStorage.getItem("asf_recent_viewed") || "[]"); }
    catch { return []; }
  });

  const trackView = React.useCallback((product) => {
    setRecent(prev => {
      const filtered = prev.filter(p => p.id !== product.id);
      const next = [{ id: product.id, emoji: product.emoji, name: product.name, tzsPrice: product.tzsPrice, unit: product.unit }, ...filtered].slice(0, MAX_RECENT);
      try { localStorage.setItem("asf_recent_viewed", JSON.stringify(next)); } catch {}
      return next;
    });
  }, []);

  return { recent, trackView };
}

function RecentlyViewed({ items, cur, onSelect, allProducts }) {
  if (!items || items.length === 0) return null;
  return (
    <div className="recent-section">
      <div className="recent-title">👀 Recently Viewed</div>
      <div className="recent-scroll">
        {items.map(item => {
          const full = allProducts.find(p => p.id === item.id) || item;
          return (
            <div key={item.id} className="recent-chip" onClick={() => onSelect(full)}>
              <span className="recent-chip-emoji">{item.emoji}</span>
              <div>
                <div className="recent-chip-name">{item.name}</div>
                <div className="recent-chip-price">{fmt(item.tzsPrice, cur)}/{item.unit}</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Receipt share via WhatsApp ──────────────────────────────────────────────────────
function buildReceiptText(orders, cur, country) {
  const lines = [
    `🧾 *Asiel Farm Shop Receipt*`,
    `📅 ${new Date().toLocaleDateString("en-TZ", { dateStyle: "medium" })}`,
    ``,
  ];
  orders.forEach((p, i) => {
    lines.push(`${i + 1}. ${p.emoji} ${p.name} — ${fmt(p.tzsPrice, cur)}/${p.unit}`);
  });
  lines.push(``);
  lines.push(`Total: *${fmt(orders.reduce((s, p) => s + p.tzsPrice, 0), cur)}*`);
  lines.push(`🌿 Farm-fresh, delivered from verified farmers`);
  lines.push(`asiel.farm`);
  return lines.join("\n");
}

// ─── Stock alert (notify me when back in stock) ──────────────────────────────────────
function useStockAlerts() {
  const [alerts, setAlerts] = React.useState(() => {
    try { return new Set(JSON.parse(localStorage.getItem("asf_stock_alerts") || "[]")); }
    catch { return new Set(); }
  });

  const toggle = React.useCallback((productId) => {
    setAlerts(prev => {
      const next = new Set(prev);
      if (next.has(productId)) next.delete(productId); else next.add(productId);
      try { localStorage.setItem("asf_stock_alerts", JSON.stringify([...next])); } catch {}
      return next;
    });
  }, []);

  return { alerts, toggle };
}

// ─── usePushSubscription — request permission + register with backend ────────────────
function usePushSubscription(isAuthenticated) {
  const [state, setState] = React.useState("idle"); // idle | prompted | subscribed | denied | unsupported

  // Convert VAPID public key string to Uint8Array
  function urlBase64ToUint8Array(base64String) {
    const padding = "=".repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
    const raw = atob(base64);
    return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
  }

  const subscribe = React.useCallback(async () => {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      setState("unsupported"); return;
    }
    try {
      const key = await apiService.getVapidKey();
      if (!key) { setState("unsupported"); return; }

      const perm = await Notification.requestPermission();
      if (perm !== "granted") { setState("denied"); return; }

      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key),
      });
      await apiService.subscribePush(sub.toJSON());
      setState("subscribed");
    } catch (err) {
      log.warn("[Push] subscribe failed:", err.message);
      setState("idle");
    }
  }, []);

  // Check existing subscription on mount
  React.useEffect(() => {
    if (!isAuthenticated || !("PushManager" in window)) return;
    navigator.serviceWorker.ready.then(reg =>
      reg.pushManager.getSubscription().then(sub => {
        if (sub) setState("subscribed");
        else setState("prompted");
      })
    ).catch(() => setState("unsupported"));
  }, [isAuthenticated]);

  return { state, subscribe };
}

// ─── SeasonalCalendar — 3-month ahead crop availability view ─────────────────────────
// Data: month indices 1-12 (Jan=1). peakMonths = best picking; inSeasonMonths = available.
const SEASON_DATA = [
  { emoji:"🥑", crop:"Hass Avocados",    loc:"Kilifi, KE",      peakMonths:[3,4,5],    inSeasonMonths:[2,3,4,5,6] },
  { emoji:"🍅", crop:"Roma Tomatoes",    loc:"Morogoro, TZ",    peakMonths:[6,7,8],    inSeasonMonths:[5,6,7,8,9] },
  { emoji:"🥬", crop:"Sukuma Wiki",       loc:"Kiambu, KE",      peakMonths:[1,2,11,12],inSeasonMonths:[1,2,3,10,11,12] },
  { emoji:"🌽", crop:"Sweet Maize",      loc:"Kisumu, KE",      peakMonths:[8,9],      inSeasonMonths:[7,8,9,10] },
  { emoji:"🧅", crop:"Red Onions",       loc:"Arusha, TZ",      peakMonths:[4,5,6],    inSeasonMonths:[3,4,5,6,7] },
  { emoji:"🥦", crop:"Broccoli",         loc:"Moshi, TZ",       peakMonths:[6,7,8,9],  inSeasonMonths:[5,6,7,8,9,10] },
  { emoji:"🍋", crop:"Limons (Limes)",   loc:"Zanzibar, TZ",    peakMonths:[10,11,12], inSeasonMonths:[9,10,11,12,1] },
  { emoji:"🥭", crop:"Mangoes",          loc:"Coast Region, KE", peakMonths:[11,12,1], inSeasonMonths:[10,11,12,1,2] },
  { emoji:"🍌", crop:"Plantains",        loc:"Tanga, TZ",       peakMonths:[1,2,3,4,5,6,7,8,9,10,11,12], inSeasonMonths:[1,2,3,4,5,6,7,8,9,10,11,12] },
];

const MONTH_NAMES = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function SeasonalCalendar({ country }) {
  const now = new Date();
  const months = [0, 1, 2].map(offset => {
    const d = new Date(now.getFullYear(), now.getMonth() + offset, 1);
    return { idx: d.getMonth() + 1, label: MONTH_NAMES[d.getMonth()] };
  });

  // Filter to show crops relevant to this country + at least one of next 3 months
  const relevant = SEASON_DATA.filter(c =>
    months.some(m => c.peakMonths.includes(m.idx) || c.inSeasonMonths.includes(m.idx))
  );

  const getStatus = (crop, monthIdx) => {
    if (crop.peakMonths.includes(monthIdx)) return "peak-season";
    if (crop.inSeasonMonths.includes(monthIdx)) return "in-season";
    return null;
  };

  // Show cards for current month prioritised by status
  const cards = relevant.map(c => {
    const thisMonth = months[0].idx;
    const status = getStatus(c, thisMonth) ||
      (getStatus(c, months[1].idx) ? "upcoming" : null);
    if (!status) return null;
    const weeksAway = status === "upcoming"
      ? Math.round(((new Date(now.getFullYear(), now.getMonth() + 1, 1)) - now) / (7 * 86400000))
      : 0;
    return { ...c, status, weeksAway };
  }).filter(Boolean);

  if (!cards.length) return null;

  return (
    <div className="season-section">
      <div className="season-title">🌿 In Season · Coming Soon</div>
      <div className="season-scroll">
        {cards.map((c, i) => (
          <div key={i} className={`season-card${c.status === "peak-season" ? " peak" : ""}`}>
            <div className="season-emoji">{c.emoji}</div>
            <div className="season-crop">{c.crop}</div>
            <div className="season-loc">{c.loc}</div>
            <span className={`season-badge ${c.status}`}>
              {c.status === "peak-season" ? "🌟 Peak now"
               : c.status === "in-season"  ? "✅ In season"
               : `⏳ In ~${c.weeksAway}w`}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── EarningsDashboard — visual weekly earnings chart for farmers ─────────────────────
// Uses static demo data in demo mode; production would fetch from /api/farmers/earnings.
const EARNINGS_DEMO = {
  thisWeek: [42000, 65000, 38000, 91000, 55000, 72000, 48000],  // Mon–Sun TZS
  lastWeek: [35000, 58000, 44000, 78000, 49000, 61000, 40000],
  topCrops: [
    { emoji:"🍅", name:"Roma Tomatoes", amt:210000 },
    { emoji:"🥑", name:"Hass Avocados", amt:168000 },
    { emoji:"🥬", name:"Sukuma Wiki",    amt:94000  },
  ],
};
const DAY_LABELS = ["M","T","W","T","F","S","S"];

function EarningsDashboard({ cur }) {
  const d = EARNINGS_DEMO;
  const maxVal = Math.max(...d.thisWeek, ...d.lastWeek);
  const totalThis = d.thisWeek.reduce((a, b) => a + b, 0);
  const totalLast = d.lastWeek.reduce((a, b) => a + b, 0);
  const growthPct = totalLast > 0
    ? Math.round(((totalThis - totalLast) / totalLast) * 100)
    : 0;

  return (
    <div className="fcard">
      <h3>📊 Earnings Dashboard</h3>
      <div className="earn-grid">
        <div className="earn-stat">
          <div className="earn-stat-val">{fmt(totalThis, cur)}</div>
          <div className="earn-stat-lbl">This week</div>
        </div>
        <div className="earn-stat">
          <div className="earn-stat-val" style={{ color: growthPct >= 0 ? "var(--leaf)" : "var(--tomato)" }}>
            {growthPct >= 0 ? "+" : ""}{growthPct}%
          </div>
          <div className="earn-stat-lbl">vs last week</div>
        </div>
      </div>

      <div className="earn-chart-wrap">
        <div className="earn-chart-title">Daily earnings (TZS)</div>
        <div className="earn-bars">
          {d.thisWeek.map((val, i) => (
            <div key={i} className="earn-bar-col">
              <div className="earn-bar last-week" style={{ height: `${(d.lastWeek[i] / maxVal) * 60}px` }}/>
              <div className="earn-bar this-week" style={{ height: `${(val / maxVal) * 60}px` }}/>
              <div className="earn-bar-lbl">{DAY_LABELS[i]}</div>
            </div>
          ))}
        </div>
        <div className="earn-legend">
          <div className="earn-leg-item"><div className="earn-leg-dot" style={{background:"var(--forest)"}}/>This week</div>
          <div className="earn-leg-item"><div className="earn-leg-dot" style={{background:"var(--sand)"}}/>Last week</div>
        </div>
      </div>

      <div className="earn-chart-title">🏆 Top selling produce</div>
      <div className="earn-top">
        {d.topCrops.map((c, i) => (
          <div key={i} className="earn-top-row">
            <span className="earn-top-emoji">{c.emoji}</span>
            <span className="earn-top-name">{c.name}</span>
            <span className="earn-top-amt">{fmt(c.amt, cur)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── ReferralCard — share code + apply code UI ───────────────────────────────────────
function ReferralCard({ showToast }) {
  const { data: refData } = useApi(() => apiService.getMyReferralCode(), []);
  const [applyCode, setApplyCode] = React.useState("");
  const [applyMsg, setApplyMsg]   = React.useState("");
  const [copying, setCopying]     = React.useState(false);

  const copyCode = React.useCallback(async () => {
    if (!refData?.code) return;
    try {
      await navigator.clipboard.writeText(refData.code);
      setCopying(true);
      showToast("Referral code copied! 🎉");
      setTimeout(() => setCopying(false), 2000);
    } catch { showToast("Code: " + refData.code); }
  }, [refData, showToast]);

  const shareWA = React.useCallback(() => {
    if (!refData?.code) return;
    const msg = encodeURIComponent(
      `Jiunge na Asiel Farm Shop — soko bora la mazao mapya kutoka kwa wakulima! Tumia code yangu ${refData.code} kupata punguzo la kwanza. https://asiel.farm`
    );
    window.open(`https://wa.me/?text=${msg}`, "_blank", "noopener");
  }, [refData]);

  const handleApply = React.useCallback(async () => {
    if (!applyCode.trim()) return;
    try {
      await apiService.useReferralCode(applyCode.trim());
      setApplyMsg("✅ Code applied — reward will be paid on your first purchase!");
      setApplyCode("");
    } catch (err) {
      setApplyMsg(`⚠ ${err.message || "Invalid code"}`);
    }
  }, [applyCode]);

  return (
    <div style={{padding:"0 0 4px"}}>
      <div className="ref-card">
        <div className="ref-title">🎁 Refer a Farmer</div>
        <div className="ref-sub">
          Share your code. Earn <strong>TZS 5,000</strong> when they make their first sale.
        </div>
        {refData && (
          <>
            <div className="ref-code-row">
              <div className="ref-code">{refData.code}</div>
              <button className="ref-copy-btn" onClick={copyCode}>
                {copying ? "Copied!" : "Copy"}
              </button>
            </div>
            <button className="ref-share-btn" onClick={shareWA}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.570-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.890-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413Z"/></svg>
              Share on WhatsApp
            </button>
            <div className="ref-stats">
              <div className="ref-stat"><div className="ref-stat-val">{refData.paid}</div><div className="ref-stat-lbl">Paid</div></div>
              <div className="ref-stat"><div className="ref-stat-val">{refData.pending}</div><div className="ref-stat-lbl">Pending</div></div>
              <div className="ref-stat"><div className="ref-stat-val">TZS {Number(refData.earned_tzs || 0).toLocaleString()}</div><div className="ref-stat-lbl">Earned</div></div>
            </div>
          </>
        )}
      </div>
      <div style={{padding:"0 16px"}}>
        <div style={{fontSize:12,color:"#aaa",marginBottom:6}}>Have a friend's referral code?</div>
        <div className="ref-input-row">
          <input className="ref-input" placeholder="Enter code e.g. DEMO01" maxLength={10}
                 value={applyCode} onChange={e => setApplyCode(e.target.value.toUpperCase())}/>
          <button className="ref-apply-btn" onClick={handleApply}>Apply</button>
        </div>
        {applyMsg && <div style={{fontSize:12,marginTop:4,color:applyMsg.startsWith("✅") ? "var(--leaf)" : "var(--tomato)"}}>{applyMsg}</div>}
      </div>
    </div>
  );
}

// ─── AddressBook — save up to 3 delivery addresses with nicknames ─────────────────────
const ADDR_ICONS = { Home:"🏠", Office:"🏢", "Mum's place":"👩", default:"📍" };
function addrIcon(nick) {
  return ADDR_ICONS[nick] || ADDR_ICONS.default;
}

function AddressBook({ country, onSelect, selectedId }) {
  const { data: addresses, loading, refetch } = useApi(() => apiService.getSavedAddresses(), []);
  const [showForm, setShowForm] = React.useState(false);
  const [form, setForm] = React.useState({ nickname: "", address: "", country, isDefault: false });
  const [saving, setSaving] = React.useState(false);

  const handleSave = React.useCallback(async () => {
    if (!form.nickname.trim() || !form.address.trim()) return;
    setSaving(true);
    try {
      await apiService.saveAddress({ ...form, country });
      setShowForm(false);
      setForm({ nickname: "", address: "", country, isDefault: false });
      refetch();
    } catch { /* ignore */ }
    setSaving(false);
  }, [form, country, refetch]);

  const handleDelete = React.useCallback(async (id, e) => {
    e.stopPropagation();
    await apiService.deleteAddress(id);
    refetch();
  }, [refetch]);

  const handleDefault = React.useCallback(async (id, e) => {
    e.stopPropagation();
    await apiService.setDefaultAddress(id);
    refetch();
  }, [refetch]);

  if (loading) return null;
  const list = addresses || [];
  const canAdd = list.length < 3;

  return (
    <div>
      <div style={{fontSize:12,fontWeight:700,color:"#aaa",textTransform:"uppercase",letterSpacing:.8,marginBottom:8}}>
        📍 Saved Addresses
      </div>
      <div className="addr-list">
        {list.map(a => (
          <div key={a.id}
               className={`addr-card${selectedId === a.id ? " selected" : ""}${a.isDefault ? " default-addr" : ""}`}
               onClick={() => onSelect?.(a)}>
            <span className="addr-icon">{addrIcon(a.nickname)}</span>
            <div className="addr-info">
              <div className="addr-nick">{a.nickname}</div>
              <div className="addr-text">{a.address}</div>
              {a.isDefault && <div className="addr-default-badge">★ Default</div>}
            </div>
            {!a.isDefault && (
              <button className="addr-del-btn" title="Set as default" onClick={e => handleDefault(a.id, e)}>☆</button>
            )}
            <button className="addr-del-btn" title="Remove" onClick={e => handleDelete(a.id, e)}>×</button>
          </div>
        ))}
      </div>
      {canAdd && !showForm && (
        <button className="addr-add-btn" onClick={() => setShowForm(true)}>+ Add address</button>
      )}
      {showForm && (
        <div className="addr-form">
          <div className="fg">
            <label>Nickname</label>
            <input placeholder="e.g. Home, Office, Mum's place" maxLength={40}
                   value={form.nickname} onChange={e => setForm(f => ({...f, nickname: e.target.value}))}/>
          </div>
          <div className="fg">
            <label>Full address</label>
            <input placeholder="Street, area, city" maxLength={500}
                   value={form.address} onChange={e => setForm(f => ({...f, address: e.target.value}))}/>
          </div>
          <div style={{display:"flex",gap:8}}>
            <button className="ob-btn-primary" style={{flex:1,padding:"11px"}}
                    onClick={handleSave} disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </button>
            <button className="ob-btn-ghost" onClick={() => setShowForm(false)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── FarmerTour — 3-screen first-time walkthrough for new farmers ─────────────────────
const TOUR_SLIDES = [
  {
    emoji: "🌾",
    title: "Welcome to Asiel AgriPass",
    desc: "Your digital farming identity card — stores your certification, farm location, and payment details. Show it at any partner hub for instant drop-off.",
  },
  {
    emoji: "📋",
    title: "Listing Your Produce",
    desc: "Tap the Farmer tab → Post My Harvest. Add photos, set your price in TZS (we convert automatically), and choose a pickup hub. Listings go live after QC approval.",
  },
  {
    emoji: "💰",
    title: "How Payouts Work",
    desc: "Once your order is delivered, M-Pesa / Tigo Pesa payout lands in your wallet within 2 hours. TRA VFD receipts are auto-generated — zero paperwork for you.",
  },
];
function FarmerTour({ onDone }) {
  const [step, setStep] = React.useState(0);
  const slide = TOUR_SLIDES[step];
  const isLast = step === TOUR_SLIDES.length - 1;

  return (
    <div className="ftour-overlay" role="dialog" aria-modal="true" aria-label="Farmer orientation tour">
      <div className="ftour-sheet">
        <div className="ftour-progress">
          {TOUR_SLIDES.map((_, i) => (
            <div key={i} className={`ftour-dot${i === step ? " active" : ""}`}/>
          ))}
        </div>
        <div className="ftour-emoji">{slide.emoji}</div>
        <div className="ftour-title">{slide.title}</div>
        <div className="ftour-desc">{slide.desc}</div>
        <div className="ftour-actions">
          <button className="ftour-skip" onClick={onDone}>Skip</button>
          <button className="ftour-next" onClick={() => isLast ? onDone() : setStep(s => s + 1)}>
            {isLast ? "Get Started 🚀" : "Next →"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── LiveTrackingMap — real-time rider position for in-progress orders ────────────────
// Uses a CSS-drawn demo map with animated rider pin; in production, rider coordinates
// come via SSE rider_location events and could be rendered on a real Leaflet map.
const DEMO_RIDER_PATH = [
  { left: "20%", top: "70%" },
  { left: "35%", top: "55%" },
  { left: "45%", top: "45%" },
  { left: "55%", top: "38%" },
  { left: "68%", top: "30%" },
  { left: "75%", top: "25%" },
];

function LiveTrackingMap({ order, riderData, onClose }) {
  const [pathIdx, setPathIdx] = React.useState(0);
  const destPct = { left: "78%", top: "22%" };

  // Simulate rider moving along path every 5 s in demo mode
  React.useEffect(() => {
    if (!API_BASE) {
      const t = setInterval(() => {
        setPathIdx(i => (i + 1 < DEMO_RIDER_PATH.length ? i + 1 : i));
      }, 5000);
      return () => clearInterval(t);
    }
  }, []);

  const pos = DEMO_RIDER_PATH[pathIdx];
  const stepsLeft = DEMO_RIDER_PATH.length - 1 - pathIdx;
  const etaMins = stepsLeft * 3 + 2;
  const rider = riderData || { name: "Juma Mwangi", vehicle: "Motorbike", phone: "+255 712 001 234" };

  return (
    <div className="track-overlay" role="dialog" aria-modal="true" aria-label="Order tracking">
      <div className="track-sheet">
        <div className="track-header">
          <h3>📦 Live Order Tracking</h3>
          <button className="track-close" onClick={onClose} aria-label="Close tracking">✕</button>
        </div>
        <div className="track-map-wrap">
          <div className="track-demo-map">
            <div className="track-road-h"/>
            <div className="track-road-v"/>
            {/* Destination pin */}
            <span className="track-dest-pin" style={destPct}>📍</span>
            {/* Rider pin — animates via CSS transition */}
            <span className="track-rider-pin" style={{ left: pos.left, top: pos.top }}>🛵</span>
          </div>
        </div>
        <div className="track-info">
          <div className="track-eta">
            {stepsLeft === 0
              ? "🎉 Arriving now!"
              : `ETA ~${etaMins} min${etaMins !== 1 ? "s" : ""}`}
          </div>
          <div className="track-addr">
            📍 {order?.address || "Your delivery address"} · {order?.id}
          </div>
          <div className="track-rider-row">
            <span className="track-rider-av">🚴</span>
            <div>
              <div className="track-rider-name">{rider.name}</div>
              <div className="track-rider-vehicle">{rider.vehicle}</div>
            </div>
            <a href={`tel:${rider.phone}`} className="track-call-btn">📞 Call</a>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── AF Lease Application — KYC + Business Appraisal + Referee Link ────────────────

const AFL_DOCS_REQUIRED = [
  'Picha moja (passporti size)',
  'Nakala ya kitambulisho (leseni ya udereva / kitambulisho cha taifa)',
  'Fomu mbili za wadhamini zilizosainiwa',
  'Barua ya kibali cha kupata taarifa kutoka benki / mkaguzi',
  'Nakala za TIN, leseni ya biashara, VAT, BRELA na Tax Clearance',
  'Mahesabu ya biashara yaliyokaguliwa (kama yapo)',
  'Proforma Invoice kutoka kwa muuzaji aliyethibitishwa',
  'Bank Statement (mwaka 1)',
  'Mauzo yaliyopita (miezi 3)',
  'Nakala ya hati ya umiliki / upangaji wa eneo la mradi',
  'Mikataba ya biashara (Tender Contracts / LPOs)',
  'Barua ya Utambulisho ya serikali ya mtaa',
];

const AFL_STEPS = [
  { id:'kyc',       label:'KYC',          icon:'🪪', title:'Maelezo Binafsi na Utambulisho' },
  { id:'business',  label:'Biashara',     icon:'🏭', title:'Maelezo ya Biashara' },
  { id:'machine',   label:'Mashine',      icon:'⚙️', title:'Mashine Inayoombewa' },
  { id:'project',   label:'Mradi',        icon:'📋', title:'Maelezo ya Mradi na Bidhaa' },
  { id:'finance',   label:'Fedha',        icon:'💰', title:'Hali ya Kifedha' },
  { id:'docs',      label:'Nyaraka',      icon:'📎', title:'Nyaraka Zinazohitajika' },
  { id:'declare',   label:'Tamko',        icon:'✍️', title:'Tamko na Utoaji Taarifa' },
];

// IndexedDB key for applications
const AFL_DB_STORE = 'afl_applications';

async function aflGetAll()    { try { return await herdAll(AFL_DB_STORE); } catch { return []; } }
async function aflPut(record) { return herdPut(AFL_DB_STORE, record); }

// ── AFLeaseApplication — full multi-step form ─────────────────────────────────────────
function AFLeaseApplication({ showToast, onClose, editId }) {
  const [step, setStep]       = React.useState(0);
  const [saving, setSaving]   = React.useState(false);
  const [appId]               = React.useState(() => editId || secureId());
  const [refereeToken]        = React.useState(() => secureId());
  const [submitted, setSubmitted] = React.useState(false);
  const [refereeLink, setRefereeLink] = React.useState('');

  // ── KYC fields ────────────────────────────────────────────────────────────────────
  const [kyc, setKyc] = React.useState({
    jinaKwanzaKati:'', jinalUkoo:'', dob:'',
    simuMkononi1:'', simuMkononi2:'', barua_pepe:'',
    mjiKijiji:'', kata:'', mtendajiKata:'', simuMtendaji:'',
    // education
    elimuMsingi:false, elimuSekondari:false, stashahada:false, shahada:false,
    // marital
    haliNdoa:'', mwenziAnajua:'',
    // personal ID
    ainaNambari:'', nambari:'',
  });

  // ── Business fields ───────────────────────────────────────────────────────────────
  const [biz, setBiz] = React.useState({
    biasharaIliyopo:'ndiyo',
    mmiliki:'', jinsiUhusika:'',
    jinaBiashara:'', mjiBiashara:'', kataBiashara:'',
    muundo:'mmoja', // kampuni | mmoja | haina
    tin:'', tinAina:'binafsi', vrn:'', vat:'',
    leseniBiashara:'', halmashauri:'',
    brelaNamaRegistration:'', brelaAnuani:'',
    shareholders:[{jina:'',asilimia:''}],
    // history
    walianzishwa:'', sababuNyongeza:'', mauzoFaida:'',
    employees:[{kazi:'',aina:'kudumu',idadi:'',wanawake:'',malipoMwezi:'',malipoBia:''}],
    matatizo:[{tatizo:'',jibu:''},{tatizo:'',jibu:''}],
  });

  // ── Machine fields ────────────────────────────────────────────────────────────────
  const [machines, setMachines] = React.useState([
    { maelezo:'', mwuzaji:'', mpya:'ndiyo', nguvu:'umeme', kwh:'', litaSaa:'', bei:'', vat:'', ushuru:'', usafiri:'', ufungaji:'', jumla:'' }
  ]);

  // ── Project / Products fields ──────────────────────────────────────────────────────
  const [project, setProject] = React.useState({
    maeleyoBiashara:'', sababuUanzishaji:'', ushindani:'',
    products:[{ jina:'', maelezo:'', kipimo:'', bei:'', mauzo1:'', mauzo2:'', mauzo3:'', msimu:'hapana', kipindi:'', kiasi:'' }],
    materials:[{ jina:'', maelezo:'', mwuzaji:'', kipimo:'', gharama:'', msimu:'hapana', kipindi:'', kiasi:'' }],
  });

  // ── Location / Licenses / Finance access ──────────────────────────────────────────
  const [ops, setOps] = React.useState({
    eonoLimepatikana:'ndiyo', umilikiAuUkodishaji:'nakodisha',
    mkataba_mpaka:'', mkataba_halali:'ndiyo', mmilikiEneo:'', kodi:'', malipo_muda:'',
    mgogoro:'hapana', hatiMiliki:'ndiyo', umemeTatu:'hapana', ukarabati:'hapana', ukarabatiMakadirio:'',
    taarifa_fedha:'', mahesabu_kukaguliwa:'hapana', mkaguzi:'',
    majaribio_mkopo:[{ taasisi:'', kiasi:'', maelezo:'' }],
    leseni:[{ bidhaa:'', leseni:'', gharama:'', hali:'' }],
  });

  // ── Financial status ──────────────────────────────────────────────────────────────
  const [fin, setFin] = React.useState({
    kipato:[{ chanzo:'', kiasi:'', muda:'', maelezo:'' }],
    akiba:[{ taasisi:'', tawi:'', salio:'', mawasiliano:'' }],
    wadaiwa:[{ jina:'', maelezo:'', kiasi:'', tarehe:'', notes:'' }],
    mali:[{ mali:'', hati:'hapana', thamani:'', maelezo:'' }],
    mikopo:[{ taasisi:'', tawi:'', aina:'', kilichokopwa:'', kilichobakia:'', tarehe:'', malipo_mwezi:'', mawasiliano:'' }],
    wadai:[{ jina:'', maelezo:'', kiasi:'', tarehe:'', notes:'' }],
    historia_mikopo:[{ taasisi:'', tawi:'', aina:'', kilichokopwa:'', muda:'', tarehe:'', mawasiliano:'' }],
  });

  // ── Docs checklist ────────────────────────────────────────────────────────────────
  const [docs, setDocs] = React.useState(() => Object.fromEntries(AFL_DOCS_REQUIRED.map(d => [d, false])));

  // ── Helpers ───────────────────────────────────────────────────────────────────────
  const totalSteps = AFL_STEPS.length;
  const currentStep = AFL_STEPS[step];

  function addRow(setter, key, template) {
    setter(prev => ({ ...prev, [key]: [...prev[key], { ...template }] }));
  }
  function updateRow(setter, key, idx, field, val) {
    setter(prev => {
      const arr = [...prev[key]];
      arr[idx] = { ...arr[idx], [field]: val };
      return { ...prev, [key]: arr };
    });
  }

  const machineTotals = machines.map(m => {
    const sum = ['bei','vat','ushuru','usafiri','ufungaji'].reduce((s,k) => s + (Number(m[k])||0), 0);
    return sum;
  });
  const grandTotal = machineTotals.reduce((s,t) => s+t, 0);

  const saveProgress = async () => {
    const record = {
      id: appId, refereeToken,
      step, kyc, biz, machines, project, ops, fin, docs,
      updatedAt: Date.now(), submitted: false,
    };
    try {
      await aflPut(record);
    } catch { /* ignore IDB errors */ }
  };

  const handleSubmit = async () => {
    setSaving(true);
    const record = {
      id: appId, refereeToken,
      step, kyc, biz, machines, project, ops, fin, docs,
      updatedAt: Date.now(), submitted: true, submittedAt: Date.now(),
    };
    try {
      await aflPut(record);
      const API = import.meta.env.VITE_API_BASE;
      if (API) {
        await fetch(`${API}/api/herd/apply`, {
          method:'POST', credentials:'include',
          headers:{'Content-Type':'application/json'},
          body: JSON.stringify(record),
        });
      }
    } catch { /* offline — saved locally */ }
    const base = window.location.origin + window.location.pathname;
    setRefereeLink(`${base}?referee=${refereeToken}&app=${appId.slice(0,8)}&name=${encodeURIComponent((kyc.jinaKwanzaKati+' '+kyc.jinalUkoo).trim())}`);
    setSaving(false);
    setSubmitted(true);
  };

  // ── Submitted screen ──────────────────────────────────────────────────────────────
  if (submitted) return (
    <div className="afl-wrap">
      <div className="afl-success">
        <div style={{fontSize:64}}>✅</div>
        <h2>Maombi Yamepokewa!</h2>
        <p>Nambari ya Maombi yako: <strong>AFL-{appId.slice(0,8).toUpperCase()}</strong></p>
        <p style={{marginTop:8,fontSize:13,color:'#666'}}>Tuma kiungo hiki kwa wadhamini wako wawili (wakadamini) wajaze fomu yao:</p>
        <div className="afl-referee-box">
          <div className="afl-referee-link">{refereeLink}</div>
          <div style={{display:'flex',gap:8,marginTop:10}}>
            <button className="afl-copy-btn" onClick={() => { navigator.clipboard?.writeText(refereeLink); showToast('Kiungo kimenakiliwa!'); }}>📋 Nakili</button>
            <a className="afl-wa-btn" href={`https://wa.me/?text=${encodeURIComponent('Habari! Tafadhali jaza fomu ya mdhamini kwa maombi yangu ya mkopo wa AF Lease:\n'+refereeLink)}`} target="_blank" rel="noopener noreferrer">
              📲 Tuma WhatsApp
            </a>
          </div>
        </div>
        <button className="herd-save-btn" style={{marginTop:20}} onClick={onClose}>← Rudi HerdPass</button>
      </div>
    </div>
  );

  // ── Progress bar ─────────────────────────────────────────────────────────────────
  const renderProgress = () => (
    <div className="afl-progress">
      {AFL_STEPS.map((s,i) => (
        <button key={s.id}
          className={`afl-step-dot${i===step?' active':i<step?' done':''}`}
          onClick={() => { saveProgress(); setStep(i); }}
          title={s.title}>
          {i < step ? '✓' : s.icon}
        </button>
      ))}
    </div>
  );

  // ── Step header ──────────────────────────────────────────────────────────────────
  const renderHeader = () => (
    <div className="afl-header">
      <div className="afl-header-top">
        <button className="afl-back" onClick={() => step > 0 ? (saveProgress(), setStep(s=>s-1)) : onClose()}>←</button>
        <div>
          <div className="afl-brand">AF Lease — Fomu ya Maombi</div>
          <div className="afl-step-title">{currentStep.icon} {currentStep.title}</div>
        </div>
        <div className="afl-counter">{step+1}/{totalSteps}</div>
      </div>
      {renderProgress()}
    </div>
  );

  const next = () => { saveProgress(); setStep(s => Math.min(s+1, totalSteps-1)); };
  const prev = () => { saveProgress(); setStep(s => Math.max(s-1, 0)); };

  // ═══ STEP 0: KYC ═══════════════════════════════════════════════════════════════
  if (step === 0) return (
    <div className="afl-wrap">
      {renderHeader()}
      <div className="afl-body">
        <div className="afl-section-title">1.1 Maelezo Binafsi</div>

        <div className="herd-2col">
          <div>
            <label className="herd-label">Jina la Kwanza na la Kati *</label>
            <input className="herd-input" placeholder="k.m. Juma Rashid" value={kyc.jinaKwanzaKati} onChange={e=>setKyc(k=>({...k,jinaKwanzaKati:e.target.value}))}/>
          </div>
          <div>
            <label className="herd-label">Jina la Ukoo *</label>
            <input className="herd-input" placeholder="k.m. Mwangi" value={kyc.jinalUkoo} onChange={e=>setKyc(k=>({...k,jinalUkoo:e.target.value}))}/>
          </div>
        </div>

        <label className="herd-label">Tarehe ya Kuzaliwa</label>
        <input type="date" className="herd-input" value={kyc.dob} onChange={e=>setKyc(k=>({...k,dob:e.target.value}))} max={new Date().toISOString().slice(0,10)}/>

        <div className="herd-2col">
          <div>
            <label className="herd-label">Simu ya Mkononi (1) *</label>
            <input className="herd-input" placeholder="+255..." value={kyc.simuMkononi1} onChange={e=>setKyc(k=>({...k,simuMkononi1:e.target.value}))}/>
          </div>
          <div>
            <label className="herd-label">Simu ya Mkononi (2)</label>
            <input className="herd-input" placeholder="+255..." value={kyc.simuMkononi2} onChange={e=>setKyc(k=>({...k,simuMkononi2:e.target.value}))}/>
          </div>
        </div>

        <label className="herd-label">Barua Pepe</label>
        <input type="email" className="herd-input" placeholder="k.m. juma@gmail.com" value={kyc.barua_pepe} onChange={e=>setKyc(k=>({...k,barua_pepe:e.target.value}))}/>

        <div className="herd-2col">
          <div>
            <label className="herd-label">Mji / Kijiji *</label>
            <input className="herd-input" placeholder="k.m. Arusha" value={kyc.mjiKijiji} onChange={e=>setKyc(k=>({...k,mjiKijiji:e.target.value}))}/>
          </div>
          <div>
            <label className="herd-label">Kata *</label>
            <input className="herd-input" placeholder="k.m. Sekei" value={kyc.kata} onChange={e=>setKyc(k=>({...k,kata:e.target.value}))}/>
          </div>
        </div>

        <div className="herd-2col">
          <div>
            <label className="herd-label">Jina la Mtendaji Kata</label>
            <input className="herd-input" value={kyc.mtendajiKata} onChange={e=>setKyc(k=>({...k,mtendajiKata:e.target.value}))}/>
          </div>
          <div>
            <label className="herd-label">Simu ya Mtendaji</label>
            <input className="herd-input" value={kyc.simuMtendaji} onChange={e=>setKyc(k=>({...k,simuMtendaji:e.target.value}))}/>
          </div>
        </div>

        <div className="afl-section-title" style={{marginTop:16}}>Utambulisho</div>
        <div className="herd-2col">
          <div>
            <label className="herd-label">Aina ya Kitambulisho</label>
            <select className="herd-input" value={kyc.ainaNambari} onChange={e=>setKyc(k=>({...k,ainaNambari:e.target.value}))}>
              <option value="">— chagua —</option>
              <option value="NIDA">NIDA (Kitambulisho cha Taifa)</option>
              <option value="Leseni ya udereva">Leseni ya udereva</option>
              <option value="Pasipoti">Pasipoti</option>
              <option value="Kitambulisho cha mpiga kura">Kadi ya mpiga kura</option>
            </select>
          </div>
          <div>
            <label className="herd-label">Namba ya Kitambulisho</label>
            <input className="herd-input" value={kyc.nambari} onChange={e=>setKyc(k=>({...k,nambari:e.target.value}))}/>
          </div>
        </div>

        <div className="afl-section-title" style={{marginTop:16}}>Elimu (§6.1)</div>
        <div style={{display:'flex',flexDirection:'column',gap:6}}>
          {[
            ['elimuMsingi','Cheti cha Elimu ya Msingi'],
            ['elimuSekondari','Cheti cha Sekondari'],
            ['stashahada','Stashahada ya Chuo'],
            ['shahada','Shahada ya Chuo Kikuu'],
          ].map(([k,label]) => (
            <label key={k} className="afl-check-row">
              <input type="checkbox" checked={kyc[k]} onChange={e=>setKyc(p=>({...p,[k]:e.target.checked}))}/>
              <span>{label}</span>
            </label>
          ))}
        </div>

        <div className="afl-section-title" style={{marginTop:16}}>Maelezo Binafsi (§6.3)</div>
        <label className="herd-label">Hali ya Ndoa</label>
        <div className="herd-row">
          {['Nimeoa/Nimeolewa','Sijaoa/Sijaolewa','Mtalaka','Mjane'].map(h => (
            <button key={h} type="button" className={`herd-chip${kyc.haliNdoa===h?' active':''}`} onClick={() => setKyc(k=>({...k,haliNdoa:h}))}>{h}</button>
          ))}
        </div>
        {(kyc.haliNdoa === 'Nimeoa/Nimeolewa') && (
          <>
            <label className="herd-label">Mwenzako anajua kuhusu maombi haya?</label>
            <div className="herd-row">
              {['Ndiyo','Hapana'].map(v => (
                <button key={v} type="button" className={`herd-chip${kyc.mwenziAnajua===v?' active':''}`} onClick={() => setKyc(k=>({...k,mwenziAnajua:v}))}>{v}</button>
              ))}
            </div>
          </>
        )}

        <button className="herd-save-btn" style={{marginTop:16}} disabled={!kyc.jinaKwanzaKati||!kyc.jinalUkoo||!kyc.simuMkononi1} onClick={next}>
          Endelea → Biashara
        </button>
      </div>
    </div>
  );

  // ═══ STEP 1: BUSINESS IDENTITY ═════════════════════════════════════════════════
  if (step === 1) return (
    <div className="afl-wrap">
      {renderHeader()}
      <div className="afl-body">
        <div className="afl-section-title">1.2 Maelezo ya Biashara</div>

        <label className="herd-label">Maombi haya ni ya biashara iliyopo?</label>
        <div className="herd-row">
          {['ndiyo','hapana'].map(v=>(
            <button key={v} type="button" className={`herd-chip${biz.biasharaIliyopo===v?' active':''}`} onClick={()=>setBiz(b=>({...b,biasharaIliyopo:v}))}>{v==='ndiyo'?'Ndiyo':'Hapana'}</button>
          ))}
        </div>

        <label className="herd-label">Nani anamiliki biashara hii? *</label>
        <input className="herd-input" placeholder="Jina kamili la mmiliki" value={biz.mmiliki} onChange={e=>setBiz(b=>({...b,mmiliki:e.target.value}))}/>

        {biz.mmiliki !== (kyc.jinaKwanzaKati+' '+kyc.jinalUkoo).trim() && biz.mmiliki && (
          <>
            <label className="herd-label">Kama sio mmiliki, unahusikaje?</label>
            <input className="herd-input" value={biz.jinsiUhusika} onChange={e=>setBiz(b=>({...b,jinsiUhusika:e.target.value}))}/>
          </>
        )}

        <label className="herd-label">Jina la Biashara *</label>
        <input className="herd-input" placeholder="Jina biashara inayotambulika" value={biz.jinaBiashara} onChange={e=>setBiz(b=>({...b,jinaBiashara:e.target.value}))}/>

        <div className="herd-2col">
          <div>
            <label className="herd-label">Mji/Kijiji (Biashara)</label>
            <input className="herd-input" value={biz.mjiBiashara} onChange={e=>setBiz(b=>({...b,mjiBiashara:e.target.value}))}/>
          </div>
          <div>
            <label className="herd-label">Kata (Biashara)</label>
            <input className="herd-input" value={biz.kataBiashara} onChange={e=>setBiz(b=>({...b,kataBiashara:e.target.value}))}/>
          </div>
        </div>

        <label className="herd-label">Muundo wa Kisheria</label>
        <div className="herd-row">
          {[['kampuni','Kampuni'],['mmoja','Mmiliki Mmoja'],['haina','Haina/Inashughulikiwa']].map(([v,l])=>(
            <button key={v} type="button" className={`herd-chip${biz.muundo===v?' active':''}`} onClick={()=>setBiz(b=>({...b,muundo:v}))}>{l}</button>
          ))}
        </div>

        <div className="afl-section-title" style={{marginTop:12}}>Usajili</div>
        <div className="herd-2col">
          <div>
            <label className="herd-label">TIN Namba</label>
            <input className="herd-input" value={biz.tin} onChange={e=>setBiz(b=>({...b,tin:e.target.value}))}/>
          </div>
          <div>
            <label className="herd-label">TIN Aina</label>
            <select className="herd-input" value={biz.tinAina} onChange={e=>setBiz(b=>({...b,tinAina:e.target.value}))}>
              <option value="binafsi">Binafsi</option>
              <option value="biashara">Biashara</option>
            </select>
          </div>
        </div>
        <div className="herd-2col">
          <div>
            <label className="herd-label">VRN Namba</label>
            <input className="herd-input" value={biz.vrn} onChange={e=>setBiz(b=>({...b,vrn:e.target.value}))}/>
          </div>
          <div>
            <label className="herd-label">VAT Namba</label>
            <input className="herd-input" value={biz.vat} onChange={e=>setBiz(b=>({...b,vat:e.target.value}))}/>
          </div>
        </div>
        <div className="herd-2col">
          <div>
            <label className="herd-label">Leseni ya Biashara</label>
            <input className="herd-input" value={biz.leseniBiashara} onChange={e=>setBiz(b=>({...b,leseniBiashara:e.target.value}))}/>
          </div>
          <div>
            <label className="herd-label">Halmashauri</label>
            <input className="herd-input" value={biz.halmashauri} onChange={e=>setBiz(b=>({...b,halmashauri:e.target.value}))}/>
          </div>
        </div>

        {biz.muundo === 'kampuni' && (
          <>
            <div className="afl-section-title" style={{marginTop:12}}>BRELA</div>
            <label className="herd-label">Jina na Namba ya Usajili wa BRELA</label>
            <input className="herd-input" value={biz.brelaNamaRegistration} onChange={e=>setBiz(b=>({...b,brelaNamaRegistration:e.target.value}))}/>
            <label className="herd-label">Anuani Iliyosajiliwa</label>
            <input className="herd-input" value={biz.brelaAnuani} onChange={e=>setBiz(b=>({...b,brelaAnuani:e.target.value}))}/>
            <div className="afl-section-title" style={{marginTop:12}}>Wanahisa</div>
            {biz.shareholders.map((sh,i) => (
              <div key={i} className="herd-2col">
                <div>
                  <label className="herd-label">Mwanahisa {i+1} — Jina</label>
                  <input className="herd-input" value={sh.jina} onChange={e=>updateRow(setBiz,'shareholders',i,'jina',e.target.value)}/>
                </div>
                <div>
                  <label className="herd-label">% ya Hisa</label>
                  <input type="number" className="herd-input" min="0" max="100" value={sh.asilimia} onChange={e=>updateRow(setBiz,'shareholders',i,'asilimia',e.target.value)}/>
                </div>
              </div>
            ))}
            {biz.shareholders.length < 4 && (
              <button type="button" className="afl-add-row" onClick={()=>addRow(setBiz,'shareholders',{jina:'',asilimia:''})}>+ Ongeza Mwanahisa</button>
            )}
          </>
        )}

        <div className="afl-nav-btns">
          <button className="afl-prev-btn" onClick={prev}>← Nyuma</button>
          <button className="herd-save-btn" style={{flex:1}} disabled={!biz.mmiliki||!biz.jinaBiashara} onClick={next}>Endelea → Mashine</button>
        </div>
      </div>
    </div>
  );

  // ═══ STEP 2: MACHINE ═══════════════════════════════════════════════════════════
  if (step === 2) return (
    <div className="afl-wrap">
      {renderHeader()}
      <div className="afl-body">
        <div className="afl-section-title">§2 — Mashine Inayoombewa (Kulingana na Proforma Invoice)</div>
        {machines.map((m,i) => (
          <div key={i} className="afl-machine-card">
            <div className="afl-machine-no">Mashine {i+1}</div>
            <label className="herd-label">Maelezo ya Mashine *</label>
            <input className="herd-input" placeholder="k.m. Mashine ya kusaga unga" value={m.maelezo} onChange={e=>{ const a=[...machines]; a[i]={...a[i],maelezo:e.target.value}; setMachines(a); }}/>
            <div className="herd-2col">
              <div>
                <label className="herd-label">Mwuzaji</label>
                <input className="herd-input" value={m.mwuzaji} onChange={e=>{ const a=[...machines]; a[i]={...a[i],mwuzaji:e.target.value}; setMachines(a); }}/>
              </div>
              <div>
                <label className="herd-label">Mpya?</label>
                <select className="herd-input" value={m.mpya} onChange={e=>{ const a=[...machines]; a[i]={...a[i],mpya:e.target.value}; setMachines(a); }}>
                  <option value="ndiyo">Ndiyo</option>
                  <option value="hapana">Hapana (Tumika)</option>
                </select>
              </div>
            </div>
            <label className="herd-label">Nishati Inayotumika</label>
            <div className="herd-row">
              {['umeme','mafuta','zote mbili'].map(n=>(
                <button key={n} type="button" className={`herd-chip${m.nguvu===n?' active':''}`} onClick={()=>{ const a=[...machines]; a[i]={...a[i],nguvu:n}; setMachines(a); }}>{n}</button>
              ))}
            </div>
            {(m.nguvu==='umeme'||m.nguvu==='zote mbili') && (
              <div>
                <label className="herd-label">Matumizi (KWH)</label>
                <input type="number" className="herd-input" min="0" value={m.kwh} onChange={e=>{ const a=[...machines]; a[i]={...a[i],kwh:e.target.value}; setMachines(a); }}/>
              </div>
            )}
            {(m.nguvu==='mafuta'||m.nguvu==='zote mbili') && (
              <div>
                <label className="herd-label">Matumizi (Lita/saa)</label>
                <input type="number" className="herd-input" min="0" step="0.1" value={m.litaSaa} onChange={e=>{ const a=[...machines]; a[i]={...a[i],litaSaa:e.target.value}; setMachines(a); }}/>
              </div>
            )}
            <div className="afl-cost-grid">
              {[['bei','Bei ya Uuzaji (TZS)'],['vat','VAT'],['ushuru','Ushuru'],['usafiri','Usafiri'],['ufungaji','Ufungaji']].map(([k,label])=>(
                <div key={k}>
                  <label className="herd-label">{label}</label>
                  <input type="number" className="herd-input" min="0" value={m[k]} onChange={e=>{ const a=[...machines]; a[i]={...a[i],[k]:e.target.value}; setMachines(a); }}/>
                </div>
              ))}
              <div>
                <label className="herd-label">Jumla ya Gharama</label>
                <div className="afl-total-display">TZS {machineTotals[i].toLocaleString()}</div>
              </div>
            </div>
          </div>
        ))}

        {machines.length < 9 && (
          <button type="button" className="afl-add-row" onClick={()=>setMachines(a=>[...a,{maelezo:'',mwuzaji:'',mpya:'ndiyo',nguvu:'umeme',kwh:'',litaSaa:'',bei:'',vat:'',ushuru:'',usafiri:'',ufungaji:'',jumla:''}])}>+ Ongeza Mashine</button>
        )}

        <div className="afl-grand-total">Jumla Kuu: TZS {grandTotal.toLocaleString()}</div>

        <div className="afl-nav-btns">
          <button className="afl-prev-btn" onClick={prev}>← Nyuma</button>
          <button className="herd-save-btn" style={{flex:1}} disabled={!machines[0].maelezo} onClick={next}>Endelea → Mradi</button>
        </div>
      </div>
    </div>
  );

  // ═══ STEP 3: PROJECT + PRODUCTS ════════════════════════════════════════════════
  if (step === 3) return (
    <div className="afl-wrap">
      {renderHeader()}
      <div className="afl-body">
        <div className="afl-section-title">§3 — Maelezo ya Mradi</div>

        <label className="herd-label">3.1.1 Eleza biashara yako inayohusika na maombi haya *</label>
        <textarea className="herd-input" rows={4} value={project.maeleyoBiashara} onChange={e=>setProject(p=>({...p,maeleyoBiashara:e.target.value}))} style={{resize:'vertical'}}/>

        <label className="herd-label">3.1.2 Sababu za kuanzisha biashara hii</label>
        <textarea className="herd-input" rows={3} value={project.sababuUanzishaji} onChange={e=>setProject(p=>({...p,sababuUanzishaji:e.target.value}))} style={{resize:'vertical'}}/>

        <label className="herd-label">3.1.3 Utofautiano wako na washindani</label>
        <textarea className="herd-input" rows={3} value={project.ushindani} onChange={e=>setProject(p=>({...p,ushindani:e.target.value}))} style={{resize:'vertical'}}/>

        {biz.biasharaIliyopo === 'ndiyo' && (
          <>
            <div className="afl-section-title" style={{marginTop:12}}>§3.2 — Biashara Iliyopo</div>
            <div className="herd-2col">
              <div>
                <label className="herd-label">Ilianzishwa lini na nani</label>
                <input className="herd-input" value={biz.walianzishwa} onChange={e=>setBiz(b=>({...b,walianzishwa:e.target.value}))}/>
              </div>
              <div>
                <label className="herd-label">Mauzo/Faida mwaka jana</label>
                <input className="herd-input" value={biz.mauzoFaida} onChange={e=>setBiz(b=>({...b,mauzoFaida:e.target.value}))}/>
              </div>
            </div>
            <label className="herd-label">Sababu za kutafuta nyongeza ya mashine</label>
            <textarea className="herd-input" rows={2} value={biz.sababuNyongeza} onChange={e=>setBiz(b=>({...b,sababuNyongeza:e.target.value}))} style={{resize:'vertical'}}/>

            <div className="afl-section-title" style={{marginTop:12}}>Wafanyakazi</div>
            {biz.employees.map((emp,i)=>(
              <div key={i} style={{display:'grid',gridTemplateColumns:'2fr 1fr 1fr',gap:6,marginBottom:6}}>
                <div>
                  <label className="herd-label">Kazi / Majukumu</label>
                  <input className="herd-input" value={emp.kazi} onChange={e=>updateRow(setBiz,'employees',i,'kazi',e.target.value)}/>
                </div>
                <div>
                  <label className="herd-label">Idadi</label>
                  <input type="number" className="herd-input" min="0" value={emp.idadi} onChange={e=>updateRow(setBiz,'employees',i,'idadi',e.target.value)}/>
                </div>
                <div>
                  <label className="herd-label">Wanawake</label>
                  <input type="number" className="herd-input" min="0" value={emp.wanawake} onChange={e=>updateRow(setBiz,'employees',i,'wanawake',e.target.value)}/>
                </div>
              </div>
            ))}
            {biz.employees.length < 8 && (
              <button type="button" className="afl-add-row" onClick={()=>addRow(setBiz,'employees',{kazi:'',aina:'kudumu',idadi:'',wanawake:'',malipoMwezi:'',malipoBia:''})}>+ Ongeza Mfanyakazi</button>
            )}
          </>
        )}

        <div className="afl-section-title" style={{marginTop:16}}>§4.1 — Bidhaa Unazouza</div>
        {project.products.map((p,i)=>(
          <div key={i} className="afl-row-card">
            <div className="afl-row-num">Bidhaa {i+1}</div>
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
              <div>
                <label className="herd-label">Jina la Bidhaa</label>
                <input className="herd-input" placeholder="k.m. mafuta ya alizeti" value={p.jina} onChange={e=>updateRow(setProject,'products',i,'jina',e.target.value)}/>
              </div>
              <div>
                <label className="herd-label">Kipimo</label>
                <input className="herd-input" placeholder="k.m. kg" value={p.kipimo} onChange={e=>updateRow(setProject,'products',i,'kipimo',e.target.value)}/>
              </div>
              <div>
                <label className="herd-label">Bei kwa Kipimo</label>
                <input type="number" className="herd-input" min="0" value={p.bei} onChange={e=>updateRow(setProject,'products',i,'bei',e.target.value)}/>
              </div>
              <div>
                <label className="herd-label">Mauzo (Mwezi 1)</label>
                <input type="number" className="herd-input" min="0" value={p.mauzo1} onChange={e=>updateRow(setProject,'products',i,'mauzo1',e.target.value)}/>
              </div>
              <div>
                <label className="herd-label">Mauzo (Mwezi 2)</label>
                <input type="number" className="herd-input" min="0" value={p.mauzo2} onChange={e=>updateRow(setProject,'products',i,'mauzo2',e.target.value)}/>
              </div>
              <div>
                <label className="herd-label">Mauzo (Mwezi 3)</label>
                <input type="number" className="herd-input" min="0" value={p.mauzo3} onChange={e=>updateRow(setProject,'products',i,'mauzo3',e.target.value)}/>
              </div>
            </div>
            <label className="herd-label">Mauzo yanaendana na msimu?</label>
            <div className="herd-row">
              {['ndiyo','hapana'].map(v=>(
                <button key={v} type="button" className={`herd-chip${p.msimu===v?' active':''}`} onClick={()=>updateRow(setProject,'products',i,'msimu',v)}>{v==='ndiyo'?'Ndiyo':'Hapana'}</button>
              ))}
            </div>
          </div>
        ))}
        {project.products.length < 10 && (
          <button type="button" className="afl-add-row" onClick={()=>addRow(setProject,'products',{jina:'',maelezo:'',kipimo:'',bei:'',mauzo1:'',mauzo2:'',mauzo3:'',msimu:'hapana',kipindi:'',kiasi:''})}>+ Ongeza Bidhaa</button>
        )}

        <div className="afl-section-title" style={{marginTop:16}}>§4.2 — Malighafi</div>
        {project.materials.map((m,i)=>(
          <div key={i} className="afl-row-card">
            <div className="afl-row-num">Malighafi {i+1}</div>
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
              <div>
                <label className="herd-label">Jina la Malighafi</label>
                <input className="herd-input" value={m.jina} onChange={e=>updateRow(setProject,'materials',i,'jina',e.target.value)}/>
              </div>
              <div>
                <label className="herd-label">Mwuzaji</label>
                <input className="herd-input" value={m.mwuzaji} onChange={e=>updateRow(setProject,'materials',i,'mwuzaji',e.target.value)}/>
              </div>
              <div>
                <label className="herd-label">Kipimo</label>
                <input className="herd-input" value={m.kipimo} onChange={e=>updateRow(setProject,'materials',i,'kipimo',e.target.value)}/>
              </div>
              <div>
                <label className="herd-label">Gharama kwa Kipimo</label>
                <input type="number" className="herd-input" min="0" value={m.gharama} onChange={e=>updateRow(setProject,'materials',i,'gharama',e.target.value)}/>
              </div>
            </div>
            <label className="herd-label">Upatikanaji unaenda na msimu?</label>
            <div className="herd-row">
              {['ndiyo','hapana'].map(v=>(
                <button key={v} type="button" className={`herd-chip${m.msimu===v?' active':''}`} onClick={()=>updateRow(setProject,'materials',i,'msimu',v)}>{v==='ndiyo'?'Ndiyo':'Hapana'}</button>
              ))}
            </div>
          </div>
        ))}
        {project.materials.length < 15 && (
          <button type="button" className="afl-add-row" onClick={()=>addRow(setProject,'materials',{jina:'',maelezo:'',mwuzaji:'',kipimo:'',gharama:'',msimu:'hapana',kipindi:'',kiasi:''})}>+ Ongeza Malighafi</button>
        )}

        <div className="afl-nav-btns">
          <button className="afl-prev-btn" onClick={prev}>← Nyuma</button>
          <button className="herd-save-btn" style={{flex:1}} disabled={!project.maeleyoBiashara} onClick={next}>Endelea → Fedha</button>
        </div>
      </div>
    </div>
  );

  // ═══ STEP 4: FINANCE ═══════════════════════════════════════════════════════════
  if (step === 4) return (
    <div className="afl-wrap">
      {renderHeader()}
      <div className="afl-body">
        <div className="afl-section-title">§7.1 — Kipato Chako cha Sasa (nje ya biashara hii)</div>
        {fin.kipato.map((r,i)=>(
          <div key={i} style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,marginBottom:8}}>
            <div>
              <label className="herd-label">Chanzo</label>
              <input className="herd-input" placeholder="k.m. mshahara, biashara nyingine" value={r.chanzo} onChange={e=>updateRow(setFin,'kipato',i,'chanzo',e.target.value)}/>
            </div>
            <div>
              <label className="herd-label">Kiasi (TZS/mwezi)</label>
              <input type="number" className="herd-input" min="0" value={r.kiasi} onChange={e=>updateRow(setFin,'kipato',i,'kiasi',e.target.value)}/>
            </div>
          </div>
        ))}
        <button type="button" className="afl-add-row" onClick={()=>addRow(setFin,'kipato',{chanzo:'',kiasi:'',muda:'',maelezo:''})}>+ Ongeza Chanzo</button>

        <div className="afl-section-title" style={{marginTop:14}}>§7.2.1 — Akiba na Uwekezaji</div>
        {fin.akiba.map((r,i)=>(
          <div key={i} style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,marginBottom:8}}>
            <div>
              <label className="herd-label">Taasisi ya Fedha</label>
              <input className="herd-input" value={r.taasisi} onChange={e=>updateRow(setFin,'akiba',i,'taasisi',e.target.value)}/>
            </div>
            <div>
              <label className="herd-label">Salio (TZS)</label>
              <input type="number" className="herd-input" min="0" value={r.salio} onChange={e=>updateRow(setFin,'akiba',i,'salio',e.target.value)}/>
            </div>
          </div>
        ))}
        <button type="button" className="afl-add-row" onClick={()=>addRow(setFin,'akiba',{taasisi:'',tawi:'',salio:'',mawasiliano:''})}>+ Ongeza Akaunti</button>

        <div className="afl-section-title" style={{marginTop:14}}>§7.2.3 — Mali na Vyombo vya Usafiri</div>
        {fin.mali.map((r,i)=>(
          <div key={i} style={{display:'grid',gridTemplateColumns:'2fr 1fr 1fr',gap:8,marginBottom:8}}>
            <div>
              <label className="herd-label">Mali</label>
              <input className="herd-input" placeholder="k.m. gari, nyumba" value={r.mali} onChange={e=>updateRow(setFin,'mali',i,'mali',e.target.value)}/>
            </div>
            <div>
              <label className="herd-label">Hati Miliki</label>
              <select className="herd-input" value={r.hati} onChange={e=>updateRow(setFin,'mali',i,'hati',e.target.value)}>
                <option value="ndiyo">Ndiyo</option>
                <option value="hapana">Hapana</option>
              </select>
            </div>
            <div>
              <label className="herd-label">Thamani (TZS)</label>
              <input type="number" className="herd-input" min="0" value={r.thamani} onChange={e=>updateRow(setFin,'mali',i,'thamani',e.target.value)}/>
            </div>
          </div>
        ))}
        <button type="button" className="afl-add-row" onClick={()=>addRow(setFin,'mali',{mali:'',hati:'hapana',thamani:'',maelezo:''})}>+ Ongeza Mali</button>

        <div className="afl-section-title" style={{marginTop:14}}>§7.3.1 — Mikopo Inayodaiwa Sasa</div>
        {fin.mikopo.map((r,i)=>(
          <div key={i} style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,marginBottom:8}}>
            <div>
              <label className="herd-label">Taasisi</label>
              <input className="herd-input" value={r.taasisi} onChange={e=>updateRow(setFin,'mikopo',i,'taasisi',e.target.value)}/>
            </div>
            <div>
              <label className="herd-label">Kilichobakia (TZS)</label>
              <input type="number" className="herd-input" min="0" value={r.kilichobakia} onChange={e=>updateRow(setFin,'mikopo',i,'kilichobakia',e.target.value)}/>
            </div>
            <div>
              <label className="herd-label">Malipo / mwezi (TZS)</label>
              <input type="number" className="herd-input" min="0" value={r.malipo_mwezi} onChange={e=>updateRow(setFin,'mikopo',i,'malipo_mwezi',e.target.value)}/>
            </div>
            <div>
              <label className="herd-label">Tarehe ya Mwisho</label>
              <input type="date" className="herd-input" value={r.tarehe} onChange={e=>updateRow(setFin,'mikopo',i,'tarehe',e.target.value)}/>
            </div>
          </div>
        ))}
        <button type="button" className="afl-add-row" onClick={()=>addRow(setFin,'mikopo',{taasisi:'',tawi:'',aina:'',kilichokopwa:'',kilichobakia:'',tarehe:'',malipo_mwezi:'',mawasiliano:''})}>+ Ongeza Mkopo</button>

        <div className="afl-section-title" style={{marginTop:14}}>§6.4 — Historia ya Mikopo Iliyokwisha Lipa</div>
        {fin.historia_mikopo.map((r,i)=>(
          <div key={i} style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,marginBottom:8}}>
            <div>
              <label className="herd-label">Taasisi</label>
              <input className="herd-input" value={r.taasisi} onChange={e=>updateRow(setFin,'historia_mikopo',i,'taasisi',e.target.value)}/>
            </div>
            <div>
              <label className="herd-label">Kiasi (TZS)</label>
              <input type="number" className="herd-input" min="0" value={r.kilichokopwa} onChange={e=>updateRow(setFin,'historia_mikopo',i,'kilichokopwa',e.target.value)}/>
            </div>
          </div>
        ))}
        <button type="button" className="afl-add-row" onClick={()=>addRow(setFin,'historia_mikopo',{taasisi:'',tawi:'',aina:'',kilichokopwa:'',muda:'',tarehe:'',mawasiliano:''})}>+ Ongeza Mkopo wa Zamani</button>

        <div className="afl-section-title" style={{marginTop:14}}>§5 — Eneo na Maelezo Zaidi ya Biashara</div>
        <label className="herd-label">Je umefanikiwa kupata eneo?</label>
        <div className="herd-row">
          {['ndiyo','hapana'].map(v=>(
            <button key={v} type="button" className={`herd-chip${ops.eonoLimepatikana===v?' active':''}`} onClick={()=>setOps(o=>({...o,eonoLimepatikana:v}))}>{v==='ndiyo'?'Ndiyo':'Hapana'}</button>
          ))}
        </div>
        {ops.eonoLimepatikana === 'ndiyo' && (
          <>
            <label className="herd-label">Unamiliki au unakodisha?</label>
            <div className="herd-row">
              {[['namiliki','Namiliki'],['nakodisha','Nakodisha']].map(([v,l])=>(
                <button key={v} type="button" className={`herd-chip${ops.umilikiAuUkodishaji===v?' active':''}`} onClick={()=>setOps(o=>({...o,umilikiAuUkodishaji:v}))}>{l}</button>
              ))}
            </div>
            {ops.umilikiAuUkodishaji === 'nakodisha' && (
              <div className="herd-2col">
                <div>
                  <label className="herd-label">Mkataba mpaka lini</label>
                  <input type="date" className="herd-input" value={ops.mkataba_mpaka} onChange={e=>setOps(o=>({...o,mkataba_mpaka:e.target.value}))}/>
                </div>
                <div>
                  <label className="herd-label">Kodi ya mwezi (TZS)</label>
                  <input type="number" className="herd-input" min="0" value={ops.kodi} onChange={e=>setOps(o=>({...o,kodi:e.target.value}))}/>
                </div>
              </div>
            )}
          </>
        )}
        <label className="herd-label">Utahitaji umeme mkubwa (laini tatu)?</label>
        <div className="herd-row">
          {['ndiyo','hapana'].map(v=>(
            <button key={v} type="button" className={`herd-chip${ops.umemeTatu===v?' active':''}`} onClick={()=>setOps(o=>({...o,umemeTatu:v}))}>{v==='ndiyo'?'Ndiyo':'Hapana'}</button>
          ))}
        </div>
        <label className="herd-label">5.3.1 — Taarifa za Fedha unazoweka</label>
        <input className="herd-input" placeholder="k.m. rejista, vitabu vya mahesabu" value={ops.taarifa_fedha} onChange={e=>setOps(o=>({...o,taarifa_fedha:e.target.value}))}/>
        <label className="herd-label">Mahesabu yamekaguliwa?</label>
        <div className="herd-row">
          {['ndiyo','hapana'].map(v=>(
            <button key={v} type="button" className={`herd-chip${ops.mahesabu_kukaguliwa===v?' active':''}`} onClick={()=>setOps(o=>({...o,mahesabu_kukaguliwa:v}))}>{v==='ndiyo'?'Ndiyo':'Hapana'}</button>
          ))}
        </div>
        {ops.mahesabu_kukaguliwa === 'ndiyo' && (
          <>
            <label className="herd-label">Maelezo ya Mkaguzi</label>
            <input className="herd-input" placeholder="Jina la kampuni au mkaguzi" value={ops.mkaguzi} onChange={e=>setOps(o=>({...o,mkaguzi:e.target.value}))}/>
          </>
        )}

        <div className="afl-nav-btns">
          <button className="afl-prev-btn" onClick={prev}>← Nyuma</button>
          <button className="herd-save-btn" style={{flex:1}} onClick={next}>Endelea → Nyaraka</button>
        </div>
      </div>
    </div>
  );

  // ═══ STEP 5: DOCUMENTS ═════════════════════════════════════════════════════════
  if (step === 5) return (
    <div className="afl-wrap">
      {renderHeader()}
      <div className="afl-body">
        <div className="afl-section-title">§9 — Nyaraka Zinazohitajika (Weka alama unazo)</div>
        <div style={{display:'flex',flexDirection:'column',gap:10}}>
          {AFL_DOCS_REQUIRED.map(doc => (
            <label key={doc} className="afl-check-row">
              <input type="checkbox" checked={!!docs[doc]} onChange={e=>setDocs(d=>({...d,[doc]:e.target.checked}))}/>
              <span>{doc}</span>
            </label>
          ))}
        </div>
        <div className="afl-docs-note">
          Nyaraka ambazo huna bado zitakusaidia kupata mkopo haraka. Ni muhimu uziwasilishe ofisini kabla ya kuchakatwa kwa maombi yako.
        </div>
        <div className="afl-nav-btns">
          <button className="afl-prev-btn" onClick={prev}>← Nyuma</button>
          <button className="herd-save-btn" style={{flex:1}} onClick={next}>Endelea → Tamko</button>
        </div>
      </div>
    </div>
  );

  // ═══ STEP 6: DECLARATION ═══════════════════════════════════════════════════════
  if (step === 6) return (
    <div className="afl-wrap">
      {renderHeader()}
      <div className="afl-body">
        <div className="afl-section-title">§10 — Tamko</div>
        <div className="afl-declaration-box">
          <p>Ahsante kwa kujaza maelezo haya.</p>
          <p style={{marginTop:8}}>Kwa kusaini/kuthibitisha fomu hii unathibitisha kwamba maelezo yaliyoko hapa ni sahihi kwa kadri ujuavyo na kwamba unatoa idhini kwetu kuhakiki katika taasisi mbalimbali za fedha kuhusu mahusiano yako na wao. Pia inairuhusu AF Lease kupata taarifa zako kutoka shirika lolote la kifedha au benki iliyosajiliwa na Serikali ya Tanzania.</p>
        </div>

        <div className="afl-summary">
          <div className="afl-summary-row"><span>Mkopaji:</span><strong>{kyc.jinaKwanzaKati} {kyc.jinalUkoo}</strong></div>
          <div className="afl-summary-row"><span>Biashara:</span><strong>{biz.jinaBiashara}</strong></div>
          <div className="afl-summary-row"><span>Mashine:</span><strong>{machines.filter(m=>m.maelezo).length} mashine</strong></div>
          <div className="afl-summary-row"><span>Jumla ya Gharama:</span><strong>TZS {grandTotal.toLocaleString()}</strong></div>
          <div className="afl-summary-row"><span>Nyaraka:</span><strong>{Object.values(docs).filter(Boolean).length}/{AFL_DOCS_REQUIRED.length} zimeandikwa</strong></div>
        </div>

        <button className="herd-save-btn" style={{marginTop:16,background:'#1a5c36'}} disabled={saving} onClick={handleSubmit}>
          {saving ? '⏳ Inahifadhiwa…' : '✅ Wasilisha Maombi na Pata Kiungo cha Mdhamini'}
        </button>
        <button className="afl-prev-btn" style={{marginTop:8,width:'100%'}} onClick={prev}>← Nyuma</button>
      </div>
    </div>
  );

  return null;
}

// ── AFLeaseRefereeForm — standalone, opened via ?referee=token ───────────────────────
function AFLeaseRefereeForm({ token, applicantName, showToast }) {
  const [form, setForm] = React.useState({
    jinaKamili:'', nambariKitambulisho:'', simu:'', barua_pepe:'',
    mjiKijiji:'', kata:'',
    uhusiano:'', miakaMfahamu:'',
    kazi:'', mwajiri:'', kipato_mwezi:'',
    haliNdoa:'',
    ridhaa:'', maelezo:'',
    tarehe: new Date().toISOString().slice(0,10),
  });
  const [saved, setSaved] = React.useState(false);
  const [saving, setSaving] = React.useState(false);

  const handleSave = async () => {
    setSaving(true);
    const record = { id: secureId(), token, applicantName, ...form, submittedAt: Date.now() };
    try {
      await herdPut('afl_referees', record);
      const API = import.meta.env.VITE_API_BASE;
      if (API) {
        await fetch(`${API}/api/herd/referee`, {
          method:'POST', credentials:'include',
          headers:{'Content-Type':'application/json'},
          body: JSON.stringify(record),
        });
      }
    } catch { /* offline */ }
    setSaving(false);
    setSaved(true);
  };

  if (saved) return (
    <div style={{minHeight:'100dvh',display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',padding:24,textAlign:'center',background:'#f5faf7'}}>
      <div style={{fontSize:64}}>✅</div>
      <h2 style={{fontSize:22,fontWeight:800,color:'#1a5c36',marginTop:12}}>Asante!</h2>
      <p style={{marginTop:8,color:'#555',fontSize:14,lineHeight:1.6}}>Fomu yako ya udhamini imehifadhiwa na kutumwa kwa AF Lease. Ombi la <strong>{applicantName}</strong> litachakatwa hivi karibuni.</p>
    </div>
  );

  return (
    <div className="afl-ref-wrap">
      <div className="afl-ref-header">
        <div className="afl-brand" style={{fontSize:16}}>AF Lease — Fomu ya Mdhamini</div>
        {applicantName && <div style={{fontSize:13,color:'rgba(255,255,255,.8)',marginTop:4}}>Kwa ombi la: <strong>{applicantName}</strong></div>}
      </div>
      <div className="afl-body">
        <div className="afl-section-title">Maelezo Yako Binafsi</div>
        <label className="herd-label">Jina Kamili *</label>
        <input className="herd-input" placeholder="Jina la kwanza, kati na ukoo" value={form.jinaKamili} onChange={e=>setForm(f=>({...f,jinaKamili:e.target.value}))}/>

        <div className="herd-2col">
          <div>
            <label className="herd-label">Namba ya Kitambulisho *</label>
            <input className="herd-input" value={form.nambariKitambulisho} onChange={e=>setForm(f=>({...f,nambariKitambulisho:e.target.value}))}/>
          </div>
          <div>
            <label className="herd-label">Simu ya Mkononi *</label>
            <input className="herd-input" placeholder="+255..." value={form.simu} onChange={e=>setForm(f=>({...f,simu:e.target.value}))}/>
          </div>
        </div>

        <div className="herd-2col">
          <div>
            <label className="herd-label">Mji / Kijiji</label>
            <input className="herd-input" value={form.mjiKijiji} onChange={e=>setForm(f=>({...f,mjiKijiji:e.target.value}))}/>
          </div>
          <div>
            <label className="herd-label">Kata</label>
            <input className="herd-input" value={form.kata} onChange={e=>setForm(f=>({...f,kata:e.target.value}))}/>
          </div>
        </div>

        <div className="afl-section-title" style={{marginTop:14}}>Uhusiano na Mwombaji</div>
        <label className="herd-label">Uhusiano wako na mwombaji *</label>
        <select className="herd-input" value={form.uhusiano} onChange={e=>setForm(f=>({...f,uhusiano:e.target.value}))}>
          <option value="">— chagua —</option>
          <option value="ndugu">Ndugu (familia)</option>
          <option value="jirani">Jirani</option>
          <option value="mwenzake_biashara">Mwenzake wa biashara</option>
          <option value="mwenzake_kazi">Mwenzake wa kazi</option>
          <option value="rafiki">Rafiki</option>
          <option value="mwingine">Mwingine</option>
        </select>
        <label className="herd-label">Unamjua kwa miaka mingapi?</label>
        <input type="number" className="herd-input" min="0" max="80" placeholder="k.m. 5" value={form.miakaMfahamu} onChange={e=>setForm(f=>({...f,miakaMfahamu:e.target.value}))}/>

        <div className="afl-section-title" style={{marginTop:14}}>Kazi na Kipato Chako</div>
        <label className="herd-label">Kazi yako / Biashara yako</label>
        <input className="herd-input" placeholder="k.m. Mwalimu, Mfanyabiashara" value={form.kazi} onChange={e=>setForm(f=>({...f,kazi:e.target.value}))}/>
        <label className="herd-label">Mwajiri / Anwani ya Biashara</label>
        <input className="herd-input" value={form.mwajiri} onChange={e=>setForm(f=>({...f,mwajiri:e.target.value}))}/>
        <label className="herd-label">Kipato cha Kila Mwezi (TZS)</label>
        <input type="number" className="herd-input" min="0" placeholder="k.m. 500000" value={form.kipato_mwezi} onChange={e=>setForm(f=>({...f,kipato_mwezi:e.target.value}))}/>

        <div className="afl-section-title" style={{marginTop:14}}>Udhamini</div>
        <label className="herd-label">Je unakubali kuwa mdhamini wa mkopo huu? *</label>
        <div className="herd-row">
          {['Ndiyo, nakubali','Hapana, sijakubali'].map(v=>(
            <button key={v} type="button" className={`herd-chip${form.ridhaa===v?' active':''}`} onClick={()=>setForm(f=>({...f,ridhaa:v}))}>{v}</button>
          ))}
        </div>
        <label className="herd-label">Maelezo ya ziada (hiari)</label>
        <textarea className="herd-input" rows={3} value={form.maelezo} onChange={e=>setForm(f=>({...f,maelezo:e.target.value}))} style={{resize:'vertical'}}/>

        <div className="afl-section-title" style={{marginTop:14}}>Tamko</div>
        <div className="afl-declaration-box" style={{fontSize:12}}>
          Kwa kutuma fomu hii, ninathibitisha kwamba maelezo niliyoyatoa ni ya kweli na sahihi. Ninakubali kushirikiana na AF Lease katika mchakato wa kuhakiki na kupitisha mkopo huu.
        </div>
        <div className="herd-2col" style={{marginTop:8}}>
          <div>
            <label className="herd-label">Tarehe</label>
            <input type="date" className="herd-input" value={form.tarehe} onChange={e=>setForm(f=>({...f,tarehe:e.target.value}))}/>
          </div>
        </div>

        <button className="herd-save-btn" style={{marginTop:16}}
          disabled={saving || !form.jinaKamili || !form.simu || !form.uhusiano || !form.ridhaa}
          onClick={handleSave}>
          {saving ? 'Inahifadhiwa…' : '✅ Wasilisha Fomu ya Udhamini'}
        </button>
      </div>
    </div>
  );
}

// ─── HerdPass — Livestock Management Module ─────────────────────────────────────────

const HERD_SPECIES = [
  { id:'cow',   label:'Cattle', icon:'🐄', types:['dairy','beef','dual'] },
  { id:'goat',  label:'Goats',  icon:'🐐', types:['dairy','meat','dual'] },
  { id:'sheep', label:'Sheep',  icon:'🐑', types:['meat','wool','dual']  },
  { id:'fish',  label:'Fish',   icon:'🐟', types:['aquaculture']          },
];

const AFRICAN_BREEDS = {
  cow: [
    'Friesian (Holstein)','Jersey','Guernsey','Ayrshire','Red Poll',
    'Sahiwal','Mpwapwa','Tanzania Shorthorn Zebu (TSZ)',
    'Boran','Ankole-Watusi','Nguni','Bonsmara','Beefmaster',
    'Crossbreed Friesian×Sahiwal','Crossbreed Boran×Simmental','Other',
  ],
  goat: [
    'Galla','Small East African (SEA)','Boer','Toggenburg','Saanen',
    'Nubian / Anglo-Nubian','Kiko','Crossbreed Galla×Boer','Other',
  ],
  sheep: [
    'Dorper','Red Masai','Blackhead Persian','East African Blackhead',
    'Merino','Suffolk','Hampshire','Crossbreed Dorper×Masai','Other',
  ],
  fish: [
    'Nile Tilapia (Oreochromis niloticus)','African Catfish (Clarias)','Rainbow Trout',
    'Common Carp (Cyprinus carpio)','Pangasius','Other',
  ],
};

const HERD_STATUSES = [
  {id:'active',    label:'Active',    color:'#2d6a4f'},
  {id:'dry',       label:'Dry',       color:'#8B7355'},
  {id:'pregnant',  label:'Pregnant',  color:'#6B8E23'},
  {id:'empty',     label:'Empty',     color:'#CD853F'},
  {id:'sold',      label:'Sold',      color:'#708090'},
  {id:'culled',    label:'Culled',    color:'#8B0000'},
];

const HEALTH_VACCINES = ['FMD','Brucellosis','Blackleg / Clostridial','Anthrax',
  'CBPP (Cattle)','Lumpy Skin Disease','Rabies','PPR (Goats & Sheep)','CCPP (Goats)',
  'Newcastle (Poultry)','Other'];
const HEALTH_TREATMENTS = ['Deworming (anthelmintic)','Tick / Flea control','Antibiotic course',
  'Anti-inflammatory (NSAID)','Wound dressing','Mastitis treatment','Foot rot treatment',
  'Bloat relief','Vitamin / mineral supplement','Other'];
const HEALTH_CHECKUPS = ['Routine vet check','Body condition score','Pregnancy diagnosis',
  'Milk quality / somatic cell count','Faecal egg count','Blood test','Other'];

const REPRO_EVENTS = ['Heat detected','AI performed','Natural service','Bull turned in',
  'Pregnancy confirmed','Pregnancy negative (open)','Expected calving / kidding date set',
  'Calving / Kidding','Abortion / Miscarriage','Stillbirth','Weaning','Drying off'];

// ── IndexedDB helpers ─────────────────────────────────────────────────────────────────
const HERD_DB_NAME    = 'asiel-herd';
const HERD_DB_VERSION = 2;
let _herdDbInstance   = null;

function openHerdDB() {
  if (_herdDbInstance) return Promise.resolve(_herdDbInstance);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(HERD_DB_NAME, HERD_DB_VERSION);
    req.onerror   = () => reject(req.error);
    req.onsuccess = (e) => { _herdDbInstance = e.target.result; resolve(_herdDbInstance); };
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('animals')) {
        const a = db.createObjectStore('animals', { keyPath:'id' });
        a.createIndex('species','species',{unique:false});
        a.createIndex('status','status',{unique:false});
      }
      if (!db.objectStoreNames.contains('events')) {
        const ev = db.createObjectStore('events', { keyPath:'id' });
        ev.createIndex('animalId','animalId',{unique:false});
        ev.createIndex('type','type',{unique:false});
        ev.createIndex('date','date',{unique:false});
      }
      if (!db.objectStoreNames.contains('leases')) {
        const l = db.createObjectStore('leases', { keyPath:'id' });
        l.createIndex('animalId','animalId',{unique:false});
      }
      if (!db.objectStoreNames.contains('afl_applications')) {
        db.createObjectStore('afl_applications', { keyPath:'id' });
      }
      if (!db.objectStoreNames.contains('afl_referees')) {
        db.createObjectStore('afl_referees', { keyPath:'id' });
      }
    };
  });
}

async function herdAll(store, indexName, query) {
  const db = await openHerdDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(store,'readonly');
    const src = tx.objectStore(store);
    const req = indexName ? src.index(indexName).getAll(query) : src.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

async function herdPut(store, record) {
  const db = await openHerdDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(store,'readwrite').objectStore(store).put(record);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

async function herdDel(store, id) {
  const db = await openHerdDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(store,'readwrite').objectStore(store).delete(id);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

// ── HerdPass main component ───────────────────────────────────────────────────────────
function HerdTab({ userRole, country, showToast, cur }) {
  const [animals,  setAnimals]  = React.useState([]);
  const [events,   setEvents]   = React.useState([]);
  const [leases,   setLeases]   = React.useState([]);
  const [view,     setView]     = React.useState('list'); // list|addAnimal|detail|addEvent|addLease|addPay
  const [selected, setSelected] = React.useState(null);   // current animal object
  const [speciesF, setSpeciesF] = React.useState('all');
  const [detailSec, setDetailSec] = React.useState('timeline'); // timeline|health|repro|production|lease
  const [eventCat, setEventCat]   = React.useState('health');
  const [saving, setSaving]       = React.useState(false);
  const [dbReady, setDbReady]     = React.useState(false);
  const [syncBadge, setSyncBadge] = React.useState('idle'); // idle|syncing|ok|error
  const [form, setForm]           = React.useState({});
  const [aflView, setAflView]     = React.useState(false); // show AFLeaseApplication overlay

  React.useEffect(() => {
    (async () => {
      try {
        const [a, ev, l] = await Promise.all([
          herdAll('animals'), herdAll('events'), herdAll('leases'),
        ]);
        setAnimals(a.sort((x,y) => (y.updatedAt||0)-(x.updatedAt||0)));
        setEvents(ev.sort((x,y) => (y.date||'')>(x.date||'')?-1:1));
        setLeases(l);
      } catch { /* IDB not available — still render */ }
      setDbReady(true);
    })();
  }, []);

  const saveAnimal = async (data) => {
    setSaving(true);
    const rec = {
      ...data,
      id:        data.id || secureId(),
      updatedAt: Date.now(),
      synced:    false,
    };
    await herdPut('animals', rec);
    setAnimals(prev => {
      const rest = prev.filter(a => a.id !== rec.id);
      return [rec, ...rest];
    });
    if (selected?.id === rec.id) setSelected(rec);
    setSaving(false);
    showToast(data.id ? 'Animal record updated' : `${rec.name || rec.tagNumber} added to herd`);
    syncHerd();
    setView(data.id ? 'detail' : 'list');
  };

  const deleteAnimal = async (animal) => {
    if (!window.confirm(`Remove ${animal.name || animal.tagNumber} from herd records? This cannot be undone.`)) return;
    await herdDel('animals', animal.id);
    setAnimals(prev => prev.filter(a => a.id !== animal.id));
    setView('list');
    showToast('Animal removed from herd');
  };

  const saveEvent = async (data) => {
    setSaving(true);
    const rec = { ...data, id: data.id || secureId(), animalId: selected.id, createdAt: Date.now(), synced: false };
    await herdPut('events', rec);
    setEvents(prev => [rec, ...prev.filter(e => e.id !== rec.id)]);
    setSaving(false);
    showToast('Event recorded');
    syncHerd();
    setView('detail');
    setDetailSec('timeline');
  };

  const saveLease = async (data) => {
    setSaving(true);
    const rec = { ...data, id: data.id || secureId(), animalId: selected.id, payments: data.payments || [], synced: false };
    await herdPut('leases', rec);
    setLeases(prev => [rec, ...prev.filter(l => l.id !== rec.id)]);
    setSaving(false);
    showToast('Lease record saved');
    syncHerd();
    setView('detail');
    setDetailSec('lease');
  };

  const addLeasePayment = async (lease, payData) => {
    const updated = { ...lease, payments: [...(lease.payments||[]), { ...payData, id: secureId(), ts: Date.now() }], synced: false };
    await herdPut('leases', updated);
    setLeases(prev => prev.map(l => l.id === updated.id ? updated : l));
    showToast('Payment recorded');
    syncHerd();
  };

  const syncHerd = async () => {
    const API = import.meta.env.VITE_API_BASE;
    if (!API) return; // demo mode
    setSyncBadge('syncing');
    try {
      const [unsyncedA, unsyncedE, unsyncedL] = await Promise.all([
        herdAll('animals').then(r => r.filter(a => !a.synced)),
        herdAll('events').then(r => r.filter(e => !e.synced)),
        herdAll('leases').then(r => r.filter(l => !l.synced)),
      ]);
      const res = await fetch(`${API}/api/herd/sync`, {
        method:'POST', credentials:'include',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ animals: unsyncedA, events: unsyncedE, leases: unsyncedL }),
      });
      if (res.ok) {
        // mark everything synced locally
        await Promise.all([
          ...unsyncedA.map(a => herdPut('animals', { ...a, synced:true })),
          ...unsyncedE.map(e => herdPut('events',  { ...e, synced:true })),
          ...unsyncedL.map(l => herdPut('leases',  { ...l, synced:true })),
        ]);
        setSyncBadge('ok');
      } else { setSyncBadge('error'); }
    } catch { setSyncBadge('error'); }
  };

  // ── Computed ────────────────────────────────────────────────────────────────────────
  const visible = speciesF === 'all' ? animals : animals.filter(a => a.species === speciesF);
  const animalEvents = selected ? events.filter(e => e.animalId === selected.id) : [];
  const animalLease  = selected ? leases.find(l => l.animalId === selected.id) : null;

  const speciesIcon = (sp) => HERD_SPECIES.find(s => s.id === sp)?.icon || '🐾';
  const statusMeta  = (st) => HERD_STATUSES.find(s => s.id === st) || { label: st, color:'#888' };

  // ── Lease maths ────────────────────────────────────────────────────────────────────
  function leaseStats(lease) {
    if (!lease) return null;
    const paid = (lease.payments||[]).reduce((s,p) => s + (Number(p.amountTzs)||0), 0);
    const total = Number(lease.principalTzs)||0;
    const remaining = Math.max(0, total - paid);
    const paidInstalments = (lease.payments||[]).length;
    const progress = total > 0 ? Math.min(100, Math.round(paid/total*100)) : 0;
    return { paid, remaining, total, paidInstalments, progress };
  }

  // ── Render ─────────────────────────────────────────────────────────────────────────
  if (!dbReady) return <div className="herd-loading"><span>🐄</span><p>Loading herd records…</p></div>;

  // ── AF Lease application overlay ──────────────────────────────────────────────
  if (aflView) return <AFLeaseApplication showToast={showToast} onClose={() => setAflView(false)}/>;

  // ── LIST VIEW ─────────────────────────────────────────────────────────────────────
  if (view === 'list') return (
    <div className="herd-wrap">
      <div className="herd-header">
        <div>
          <div className="herd-title">HerdPass</div>
          <div className="herd-subtitle">
            {animals.length} animals · {leases.length} leases
            {syncBadge === 'ok'      && <span className="herd-sync ok">✓ synced</span>}
            {syncBadge === 'syncing' && <span className="herd-sync">↻ syncing…</span>}
            {syncBadge === 'error'   && <span className="herd-sync err">⚠ offline</span>}
          </div>
        </div>
        <div style={{display:'flex',flexDirection:'column',gap:6}}>
          <button className="herd-add-btn" onClick={() => { setForm({ species:'cow', category:'dairy', sex:'female', status:'active' }); setView('addAnimal'); }}>
            + Add Animal
          </button>
          <button className="afl-apply-btn" onClick={() => setAflView(true)}>
            📋 Omba AF Lease
          </button>
        </div>
      </div>

      {/* Species filter chips */}
      <div className="herd-chips">
        <button className={`herd-chip${speciesF==='all'?' active':''}`} onClick={() => setSpeciesF('all')}>All ({animals.length})</button>
        {HERD_SPECIES.map(sp => {
          const n = animals.filter(a => a.species === sp.id).length;
          return n > 0 ? (
            <button key={sp.id} className={`herd-chip${speciesF===sp.id?' active':''}`} onClick={() => setSpeciesF(sp.id)}>
              {sp.icon} {sp.label} ({n})
            </button>
          ) : null;
        })}
      </div>

      {visible.length === 0 ? (
        <div className="herd-empty">
          <div style={{fontSize:64}}>🐾</div>
          <h3>No animals yet</h3>
          <p>Add your first animal to start tracking health, production, and finances.</p>
          <button className="herd-add-btn" onClick={() => { setForm({ species:'cow', category:'dairy', sex:'female', status:'active' }); setView('addAnimal'); }}>
            + Add First Animal
          </button>
        </div>
      ) : (
        <div className="herd-grid">
          {visible.map(animal => {
            const sm = statusMeta(animal.status);
            const anEv = events.filter(e => e.animalId === animal.id);
            const lastEv = anEv[0];
            return (
              <div key={animal.id} className="herd-card" onClick={() => { setSelected(animal); setDetailSec('timeline'); setView('detail'); }}>
                <div className="herd-card-top">
                  <span className="herd-species-icon">{speciesIcon(animal.species)}</span>
                  <div style={{flex:1,minWidth:0}}>
                    <div className="herd-card-name">{animal.name || animal.tagNumber}</div>
                    {animal.name && <div className="herd-card-tag">#{animal.tagNumber}</div>}
                  </div>
                  <span className="herd-status-dot" style={{background:sm.color}} title={sm.label}/>
                </div>
                <div className="herd-card-meta">
                  <span>{animal.breed || animal.category}</span>
                  {animal.sex && <span>· {animal.sex}</span>}
                  {animal.dob && <span>· {(() => { const d = Math.floor((Date.now()-new Date(animal.dob))/86400000/365.25); return d < 1 ? '< 1 yr' : `${d} yr${d>1?'s':''}`; })()}</span>}
                </div>
                <div className="herd-card-footer">
                  <span className="herd-status-pill" style={{background:sm.color+'22',color:sm.color}}>{sm.label}</span>
                  {lastEv && <span className="herd-last-ev">Last: {lastEv.subtype || lastEv.type} {lastEv.date}</span>}
                  {animalLease && <span className="herd-lease-tag">📋 Lease</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );

  // ── ADD / EDIT ANIMAL ─────────────────────────────────────────────────────────────
  if (view === 'addAnimal') {
    const sp = HERD_SPECIES.find(s => s.id === (form.species||'cow'));
    const breeds = AFRICAN_BREEDS[form.species||'cow'] || [];
    return (
      <div className="herd-wrap">
        <div className="herd-nav-back">
          <button onClick={() => setView(form.id ? 'detail' : 'list')}>← Back</button>
          <span>{form.id ? 'Edit Animal' : 'Add New Animal'}</span>
        </div>
        <div className="herd-form">
          {/* Species */}
          <label className="herd-label">Species</label>
          <div className="herd-species-row">
            {HERD_SPECIES.map(s => (
              <button key={s.id} type="button"
                className={`herd-species-btn${form.species===s.id?' active':''}`}
                onClick={() => setForm(f => ({ ...f, species:s.id, breed:'', category:s.types[0] }))}>
                {s.icon} {s.label}
              </button>
            ))}
          </div>

          {/* Category */}
          <label className="herd-label">Category / Purpose</label>
          <div className="herd-row">
            {(sp?.types||[]).map(t => (
              <button key={t} type="button"
                className={`herd-chip${form.category===t?' active':''}`}
                onClick={() => setForm(f => ({ ...f, category:t }))}>
                {t}
              </button>
            ))}
          </div>

          {/* Tag & Name */}
          <div className="herd-2col">
            <div>
              <label className="herd-label">Ear Tag / ID *</label>
              <input className="herd-input" placeholder="e.g. TZ-001" value={form.tagNumber||''} onChange={e => setForm(f => ({...f,tagNumber:e.target.value}))}/>
            </div>
            <div>
              <label className="herd-label">Name (optional)</label>
              <input className="herd-input" placeholder="e.g. Zawadi" value={form.name||''} onChange={e => setForm(f => ({...f,name:e.target.value}))}/>
            </div>
          </div>

          {/* Breed */}
          <label className="herd-label">Breed</label>
          <select className="herd-input" value={form.breed||''} onChange={e => setForm(f => ({...f,breed:e.target.value}))}>
            <option value="">— select breed —</option>
            {breeds.map(b => <option key={b} value={b}>{b}</option>)}
          </select>

          {/* Sex & DOB */}
          <div className="herd-2col">
            <div>
              <label className="herd-label">Sex</label>
              <select className="herd-input" value={form.sex||'female'} onChange={e => setForm(f => ({...f,sex:e.target.value}))}>
                <option value="female">Female</option>
                <option value="male">Male</option>
                <option value="castrated">Castrated (steer)</option>
              </select>
            </div>
            <div>
              <label className="herd-label">Date of Birth</label>
              <input type="date" className="herd-input" value={form.dob||''} onChange={e => setForm(f => ({...f,dob:e.target.value}))} max={new Date().toISOString().slice(0,10)}/>
            </div>
          </div>

          {/* Entry */}
          <div className="herd-2col">
            <div>
              <label className="herd-label">Entry Method</label>
              <select className="herd-input" value={form.entryMethod||''} onChange={e => setForm(f => ({...f,entryMethod:e.target.value}))}>
                <option value="">— select —</option>
                <option value="born on farm">Born on farm</option>
                <option value="purchased">Purchased</option>
                <option value="leased (AF lease)">Leased (AF Lease / HP)</option>
                <option value="donated">Donated</option>
                <option value="transferred">Transferred</option>
              </select>
            </div>
            <div>
              <label className="herd-label">Entry Date</label>
              <input type="date" className="herd-input" value={form.entryDate||''} onChange={e => setForm(f => ({...f,entryDate:e.target.value}))} max={new Date().toISOString().slice(0,10)}/>
            </div>
          </div>

          {/* Status */}
          <label className="herd-label">Current Status</label>
          <div className="herd-row">
            {HERD_STATUSES.map(s => (
              <button key={s.id} type="button"
                className={`herd-chip${form.status===s.id?' active':''}`}
                style={form.status===s.id?{background:s.color+'22',color:s.color,borderColor:s.color}:{}}
                onClick={() => setForm(f => ({...f,status:s.id}))}>
                {s.label}
              </button>
            ))}
          </div>

          {/* Lactation number (dairy only) */}
          {(form.category === 'dairy' || form.category === 'dual') && form.sex === 'female' && (
            <>
              <label className="herd-label">Lactation Number</label>
              <input type="number" className="herd-input" min="0" max="20" placeholder="0 = heifer" value={form.lactationNo||''} onChange={e => setForm(f => ({...f,lactationNo:e.target.value}))}/>
            </>
          )}

          {/* Live weight */}
          <div className="herd-2col">
            <div>
              <label className="herd-label">Live Weight (kg)</label>
              <input type="number" className="herd-input" min="0" max="2000" placeholder="e.g. 320" value={form.weightKg||''} onChange={e => setForm(f => ({...f,weightKg:e.target.value}))}/>
            </div>
            <div>
              <label className="herd-label">Colour / Markings</label>
              <input className="herd-input" placeholder="e.g. Black & white" value={form.colour||''} onChange={e => setForm(f => ({...f,colour:e.target.value}))}/>
            </div>
          </div>

          {/* Notes */}
          <label className="herd-label">Notes</label>
          <textarea className="herd-input" rows={3} placeholder="Any other details…" value={form.notes||''} onChange={e => setForm(f => ({...f,notes:e.target.value}))} style={{resize:'vertical'}}/>

          <button className="herd-save-btn" disabled={saving || !form.tagNumber} onClick={() => saveAnimal(form)}>
            {saving ? 'Saving…' : (form.id ? 'Update Animal' : 'Add to Herd')}
          </button>
        </div>
      </div>
    );
  }

  // ── ANIMAL DETAIL ─────────────────────────────────────────────────────────────────
  if (view === 'detail' && selected) {
    const sm = statusMeta(selected.status);
    const lease = animalLease;
    const ls = leaseStats(lease);
    const healthEv   = animalEvents.filter(e => e.type === 'health');
    const reproEv    = animalEvents.filter(e => e.type === 'repro');
    const prodEv     = animalEvents.filter(e => e.type === 'production');
    const isDairy    = selected.category === 'dairy' || selected.category === 'dual';

    return (
      <div className="herd-wrap">
        <div className="herd-nav-back">
          <button onClick={() => setView('list')}>← Herd</button>
          <div style={{display:'flex',gap:8}}>
            <button className="herd-edit-btn" onClick={() => { setForm({...selected}); setView('addAnimal'); }}>Edit</button>
            <button className="herd-del-btn" onClick={() => deleteAnimal(selected)}>Delete</button>
          </div>
        </div>

        {/* Animal header card */}
        <div className="herd-detail-hero">
          <span className="herd-species-icon" style={{fontSize:48}}>{speciesIcon(selected.species)}</span>
          <div style={{flex:1}}>
            <div className="herd-detail-name">{selected.name || `#${selected.tagNumber}`}</div>
            {selected.name && <div style={{color:'rgba(255,255,255,.7)',fontSize:13}}>Tag #{selected.tagNumber}</div>}
            <div style={{display:'flex',gap:8,marginTop:8,flexWrap:'wrap'}}>
              <span className="herd-status-pill" style={{background:'rgba(255,255,255,.2)',color:'white'}}>{sm.label}</span>
              <span className="herd-status-pill" style={{background:'rgba(255,255,255,.15)',color:'white'}}>{selected.breed || selected.category}</span>
              {selected.sex && <span className="herd-status-pill" style={{background:'rgba(255,255,255,.15)',color:'white'}}>{selected.sex}</span>}
              {selected.weightKg && <span className="herd-status-pill" style={{background:'rgba(255,255,255,.15)',color:'white'}}>{selected.weightKg} kg</span>}
            </div>
          </div>
        </div>

        {/* Quick stats */}
        {selected.dob && (() => {
          const ageDays = Math.floor((Date.now()-new Date(selected.dob))/86400000);
          const ageYrs  = Math.floor(ageDays/365.25);
          const ageMos  = Math.floor((ageDays%365.25)/30.44);
          return (
            <div className="herd-stats-row">
              <div className="herd-stat"><span>{ageYrs > 0 ? `${ageYrs}y ${ageMos}m` : `${ageMos}m`}</span><label>Age</label></div>
              <div className="herd-stat"><span>{healthEv.length}</span><label>Health events</label></div>
              <div className="herd-stat"><span>{reproEv.length}</span><label>Repro events</label></div>
              {isDairy && <div className="herd-stat"><span>{prodEv.length}</span><label>Milk records</label></div>}
              {ls && <div className="herd-stat"><span>{ls.progress}%</span><label>Lease paid</label></div>}
            </div>
          );
        })()}

        {/* Section tabs */}
        <div className="herd-sec-tabs">
          {[
            {id:'timeline',  label:'Timeline'},
            {id:'health',    label:'Health'},
            {id:'repro',     label:'Repro', hide: selected.species === 'fish'},
            {id:'production',label: isDairy ? 'Milk' : 'Weight'},
            {id:'lease',     label:'Lease'},
          ].filter(s => !s.hide).map(s => (
            <button key={s.id} className={`herd-sec-tab${detailSec===s.id?' active':''}`} onClick={() => setDetailSec(s.id)}>
              {s.label}
            </button>
          ))}
        </div>

        {/* ── Timeline ── */}
        {detailSec === 'timeline' && (
          <div className="herd-section">
            <div className="herd-section-header">
              <span>All Events ({animalEvents.length})</span>
              <div style={{display:'flex',gap:6}}>
                <button className="herd-add-ev-btn" onClick={() => { setForm({type:'health',subtype:'vaccination',vaccine:HEALTH_VACCINES[0],date:new Date().toISOString().slice(0,10)}); setView('addEvent'); }}>+ Health</button>
                {selected.species !== 'fish' && <button className="herd-add-ev-btn" onClick={() => { setForm({type:'repro',subtype:'Heat detected',date:new Date().toISOString().slice(0,10)}); setView('addEvent'); }}>+ Repro</button>}
                <button className="herd-add-ev-btn" onClick={() => { setForm({type:'production',subtype:isDairy?'milk':'weight',value:'',unit:isDairy?'litres':'kg',date:new Date().toISOString().slice(0,10)}); setView('addEvent'); }}>+ {isDairy?'Milk':'Weight'}</button>
              </div>
            </div>
            {animalEvents.length === 0 ? (
              <div className="herd-empty-sm">No events recorded yet. Use the buttons above to log health, reproduction, or production events.</div>
            ) : (
              <div className="herd-timeline">
                {animalEvents.map(ev => (
                  <div key={ev.id} className="herd-ev-row">
                    <div className="herd-ev-dot" style={{background: ev.type==='health'?'#e63946':ev.type==='repro'?'#6B8E23':'#2d6a4f'}}/>
                    <div className="herd-ev-body">
                      <div className="herd-ev-title">{ev.subtype} {ev.value ? `— ${ev.value} ${ev.unit||''}` : ''}</div>
                      <div className="herd-ev-meta">{ev.date} {ev.vet ? `· ${ev.vet}` : ''} {ev.cost ? `· TZS ${Number(ev.cost).toLocaleString()}` : ''}</div>
                      {ev.notes && <div className="herd-ev-notes">{ev.notes}</div>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── Health ── */}
        {detailSec === 'health' && (
          <div className="herd-section">
            <div className="herd-section-header">
              <span>Health Events ({healthEv.length})</span>
              <button className="herd-add-ev-btn" onClick={() => { setForm({type:'health',subtype:'vaccination',vaccine:HEALTH_VACCINES[0],date:new Date().toISOString().slice(0,10)}); setView('addEvent'); }}>+ Log Event</button>
            </div>

            {/* Upcoming vaccinations reminder */}
            {healthEv.filter(e=>e.subtype==='vaccination'&&e.nextDue).length > 0 && (
              <div className="herd-reminder-box">
                📅 <strong>Due soon:</strong> {healthEv.filter(e=>e.subtype==='vaccination'&&e.nextDue).map(e=>`${e.vaccine} (${e.nextDue})`).join(', ')}
              </div>
            )}

            {healthEv.length === 0 ? (
              <div className="herd-empty-sm">No health events recorded.</div>
            ) : (
              <div className="herd-timeline">
                {healthEv.map(ev => (
                  <div key={ev.id} className="herd-ev-row">
                    <div className="herd-ev-dot" style={{background:'#e63946'}}/>
                    <div className="herd-ev-body">
                      <div className="herd-ev-title">{ev.subtype === 'vaccination' ? `💉 ${ev.vaccine}` : ev.subtype === 'treatment' ? `💊 ${ev.drug||ev.subtype}` : `🩺 ${ev.subtype}`}</div>
                      <div className="herd-ev-meta">{ev.date} {ev.vet?`· Dr. ${ev.vet}`:''} {ev.cost?`· TZS ${Number(ev.cost).toLocaleString()}`:''} {ev.nextDue?`· Next: ${ev.nextDue}`:''}</div>
                      {ev.notes && <div className="herd-ev-notes">{ev.notes}</div>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── Reproduction ── */}
        {detailSec === 'repro' && selected.species !== 'fish' && (
          <div className="herd-section">
            <div className="herd-section-header">
              <span>Reproduction ({reproEv.length})</span>
              <button className="herd-add-ev-btn" onClick={() => { setForm({type:'repro',subtype:'Heat detected',date:new Date().toISOString().slice(0,10)}); setView('addEvent'); }}>+ Log Event</button>
            </div>
            {(() => {
              const lastCalving = reproEv.find(e => e.subtype === 'Calving / Kidding');
              const pregnant    = reproEv.find(e => e.subtype === 'Pregnancy confirmed');
              const expected    = reproEv.find(e => e.subtype === 'Expected calving / kidding date set');
              return (pregnant || expected || lastCalving) ? (
                <div className="herd-repro-summary">
                  {pregnant   && <div>✅ <strong>Pregnant</strong> (confirmed {pregnant.date})</div>}
                  {expected   && <div>📅 Expected: <strong>{expected.expectedDate || expected.notes}</strong></div>}
                  {lastCalving&& <div>🐣 Last calving: <strong>{lastCalving.date}</strong></div>}
                  {selected.lactationNo && <div>🥛 Lactation #<strong>{selected.lactationNo}</strong></div>}
                </div>
              ) : null;
            })()}
            {reproEv.length === 0 ? (
              <div className="herd-empty-sm">No reproduction events recorded.</div>
            ) : (
              <div className="herd-timeline">
                {reproEv.map(ev => (
                  <div key={ev.id} className="herd-ev-row">
                    <div className="herd-ev-dot" style={{background:'#6B8E23'}}/>
                    <div className="herd-ev-body">
                      <div className="herd-ev-title">{ev.subtype} {ev.bullId?`· Bull/Sire: ${ev.bullId}`:''} {ev.bullSemen?`· ${ev.bullSemen}`:''}</div>
                      <div className="herd-ev-meta">{ev.date} {ev.vet?`· ${ev.vet}`:''} {ev.cost?`· TZS ${Number(ev.cost).toLocaleString()}`:''}</div>
                      {ev.notes && <div className="herd-ev-notes">{ev.notes}</div>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── Production (Milk / Weight) ── */}
        {detailSec === 'production' && (
          <div className="herd-section">
            <div className="herd-section-header">
              <span>{isDairy ? 'Milk Records' : 'Weight Records'} ({prodEv.length})</span>
              <button className="herd-add-ev-btn" onClick={() => { setForm({type:'production',subtype:isDairy?'milk':'weight',value:'',unit:isDairy?'litres':'kg',date:new Date().toISOString().slice(0,10)}); setView('addEvent'); }}>+ Log {isDairy?'Milk':'Weight'}</button>
            </div>
            {prodEv.length === 0 ? (
              <div className="herd-empty-sm">No {isDairy?'milk':'weight'} records yet.</div>
            ) : (() => {
              // Simple 7-day rolling average for milk
              const recent7 = prodEv.slice(0,7);
              const avg = recent7.length > 0 ? (recent7.reduce((s,e)=>s+(Number(e.value)||0),0)/recent7.length).toFixed(1) : null;
              const best = Math.max(...prodEv.map(e=>Number(e.value)||0));
              return (
                <>
                  <div className="herd-stats-row">
                    {isDairy && avg !== null && <div className="herd-stat"><span>{avg}</span><label>Avg litres (7d)</label></div>}
                    <div className="herd-stat"><span>{best}</span><label>Best {isDairy?'litres':'kg'}</label></div>
                    <div className="herd-stat"><span>{prodEv.length}</span><label>Records</label></div>
                  </div>
                  <div className="herd-timeline">
                    {prodEv.map(ev => (
                      <div key={ev.id} className="herd-ev-row">
                        <div className="herd-ev-dot" style={{background:'#2d6a4f'}}/>
                        <div className="herd-ev-body">
                          <div className="herd-ev-title">{isDairy?'🥛':'⚖️'} {ev.value} {ev.unit} {isDairy&&ev.session?`(${ev.session})`:''}</div>
                          <div className="herd-ev-meta">{ev.date} {ev.milkQuality?`· Quality: ${ev.milkQuality}`:''}</div>
                          {ev.notes && <div className="herd-ev-notes">{ev.notes}</div>}
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              );
            })()}
          </div>
        )}

        {/* ── Lease / AF Lease Finance ── */}
        {detailSec === 'lease' && (
          <div className="herd-section">
            <div className="herd-section-header">
              <span>Lease / Hire-Purchase</span>
              {!lease && <button className="herd-add-ev-btn" onClick={() => { setForm({type:'lease',lenderName:'AF Lease',frequency:'monthly',startDate:new Date().toISOString().slice(0,10)}); setView('addLease'); }}>+ Add Lease</button>}
            </div>
            {!lease ? (
              <div className="herd-empty-sm">No lease linked to this animal. If this animal was acquired through AF Lease or another hire-purchase scheme, add the lease details above.</div>
            ) : (
              <>
                <div className="herd-lease-card">
                  <div className="herd-lease-header">
                    <div>
                      <div className="herd-lease-lender">{lease.lenderName}</div>
                      <div className="herd-lease-dates">{lease.startDate} · {lease.frequency}</div>
                    </div>
                    <button className="herd-edit-btn" onClick={() => { setForm({...lease}); setView('addLease'); }}>Edit</button>
                  </div>
                  <div className="herd-progress-bar">
                    <div className="herd-progress-fill" style={{width:`${ls.progress}%`}}/>
                  </div>
                  <div className="herd-lease-stats">
                    <div><span>Principal</span><strong>TZS {Number(lease.principalTzs).toLocaleString()}</strong></div>
                    <div><span>Paid</span><strong style={{color:'#2d6a4f'}}>TZS {ls.paid.toLocaleString()}</strong></div>
                    <div><span>Remaining</span><strong style={{color:ls.remaining>0?'#c62828':'#2d6a4f'}}>TZS {ls.remaining.toLocaleString()}</strong></div>
                    <div><span>Instalment</span><strong>TZS {Number(lease.instalmentAmountTzs||0).toLocaleString()}</strong></div>
                    <div><span>Instalments paid</span><strong>{ls.paidInstalments} / {lease.totalInstalments||'—'}</strong></div>
                    <div><span>Progress</span><strong>{ls.progress}%</strong></div>
                  </div>
                  {ls.remaining <= 0 && <div className="herd-lease-done">✅ Lease fully paid — animal ownership transferred</div>}
                </div>

                {/* Payment history */}
                <div className="herd-section-header" style={{marginTop:16}}>
                  <span>Payments ({(lease.payments||[]).length})</span>
                  {ls.remaining > 0 && <button className="herd-add-ev-btn" onClick={() => { setForm({amountTzs:'',ref:'',payDate:new Date().toISOString().slice(0,10),notes:'',leaseId:lease.id}); setView('addPay'); }}>+ Record Payment</button>}
                </div>
                {(lease.payments||[]).length === 0 ? (
                  <div className="herd-empty-sm">No payments recorded yet.</div>
                ) : (
                  <div className="herd-timeline">
                    {[...(lease.payments||[])].reverse().map(p => (
                      <div key={p.id} className="herd-ev-row">
                        <div className="herd-ev-dot" style={{background:'#2d6a4f'}}/>
                        <div className="herd-ev-body">
                          <div className="herd-ev-title">💰 TZS {Number(p.amountTzs).toLocaleString()} {p.method?`via ${p.method}`:''}</div>
                          <div className="herd-ev-meta">{p.payDate} {p.ref?`· Ref: ${p.ref}`:''}</div>
                          {p.notes && <div className="herd-ev-notes">{p.notes}</div>}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    );
  }

  // ── ADD EVENT ─────────────────────────────────────────────────────────────────────
  if (view === 'addEvent' && selected) {
    const isDairy = selected.category === 'dairy' || selected.category === 'dual';
    const isMilk  = form.type === 'production' && (form.subtype === 'milk' || isDairy);

    return (
      <div className="herd-wrap">
        <div className="herd-nav-back">
          <button onClick={() => setView('detail')}>← {selected.name || `#${selected.tagNumber}`}</button>
          <span>{form.type === 'health' ? 'Log Health Event' : form.type === 'repro' ? 'Log Reproduction Event' : isMilk ? 'Log Milk Record' : 'Log Weight'}</span>
        </div>
        <div className="herd-form">

          {/* ── Health event ── */}
          {form.type === 'health' && (
            <>
              <label className="herd-label">Event Category</label>
              <div className="herd-row">
                {['vaccination','treatment','checkup'].map(c => (
                  <button key={c} type="button"
                    className={`herd-chip${form.subtype===c?' active':''}`}
                    onClick={() => setForm(f => ({...f,subtype:c,vaccine:HEALTH_VACCINES[0],drug:''}))}>
                    {c === 'vaccination' ? '💉 Vaccine' : c === 'treatment' ? '💊 Treatment' : '🩺 Check-up'}
                  </button>
                ))}
              </div>

              {form.subtype === 'vaccination' && (
                <>
                  <label className="herd-label">Vaccine *</label>
                  <select className="herd-input" value={form.vaccine||''} onChange={e => setForm(f => ({...f,vaccine:e.target.value}))}>
                    {HEALTH_VACCINES.map(v => <option key={v} value={v}>{v}</option>)}
                  </select>
                  <label className="herd-label">Next Due Date</label>
                  <input type="date" className="herd-input" value={form.nextDue||''} onChange={e => setForm(f => ({...f,nextDue:e.target.value}))}/>
                </>
              )}
              {form.subtype === 'treatment' && (
                <>
                  <label className="herd-label">Treatment Type *</label>
                  <select className="herd-input" value={form.drug||''} onChange={e => setForm(f => ({...f,drug:e.target.value}))}>
                    <option value="">— select —</option>
                    {HEALTH_TREATMENTS.map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                  <label className="herd-label">Drug / Product</label>
                  <input className="herd-input" placeholder="e.g. Oxytetracycline" value={form.drugName||''} onChange={e => setForm(f => ({...f,drugName:e.target.value}))}/>
                </>
              )}
              {form.subtype === 'checkup' && (
                <>
                  <label className="herd-label">Check-up Type</label>
                  <select className="herd-input" value={form.checkupType||''} onChange={e => setForm(f => ({...f,checkupType:e.target.value}))}>
                    <option value="">— select —</option>
                    {HEALTH_CHECKUPS.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </>
              )}

              <div className="herd-2col">
                <div>
                  <label className="herd-label">Date *</label>
                  <input type="date" className="herd-input" value={form.date||''} onChange={e => setForm(f => ({...f,date:e.target.value}))} max={new Date().toISOString().slice(0,10)}/>
                </div>
                <div>
                  <label className="herd-label">Cost (TZS)</label>
                  <input type="number" className="herd-input" min="0" value={form.cost||''} onChange={e => setForm(f => ({...f,cost:e.target.value}))} placeholder="0"/>
                </div>
              </div>
              <label className="herd-label">Vet / Officer Name</label>
              <input className="herd-input" placeholder="e.g. Dr. Ally" value={form.vet||''} onChange={e => setForm(f => ({...f,vet:e.target.value}))}/>
            </>
          )}

          {/* ── Reproduction event ── */}
          {form.type === 'repro' && (
            <>
              <label className="herd-label">Event Type *</label>
              <select className="herd-input" value={form.subtype||''} onChange={e => setForm(f => ({...f,subtype:e.target.value}))}>
                {REPRO_EVENTS.map(r => <option key={r} value={r}>{r}</option>)}
              </select>
              {(form.subtype === 'AI performed' || form.subtype === 'Natural service') && (
                <>
                  <label className="herd-label">{form.subtype === 'AI performed' ? 'Semen / Bull Sire ID' : 'Bull Tag / Name'}</label>
                  <input className="herd-input" placeholder="e.g. BULL-042 / Sahiwal Elite" value={form.bullSemen||''} onChange={e => setForm(f => ({...f,bullSemen:e.target.value}))}/>
                </>
              )}
              {form.subtype === 'Expected calving / kidding date set' && (
                <>
                  <label className="herd-label">Expected Date *</label>
                  <input type="date" className="herd-input" value={form.expectedDate||''} onChange={e => setForm(f => ({...f,expectedDate:e.target.value}))}/>
                </>
              )}
              {form.subtype === 'Calving / Kidding' && (
                <>
                  <div className="herd-2col">
                    <div>
                      <label className="herd-label">Number of offspring</label>
                      <input type="number" className="herd-input" min="0" max="10" value={form.offspringCount||1} onChange={e => setForm(f => ({...f,offspringCount:e.target.value}))}/>
                    </div>
                    <div>
                      <label className="herd-label">Outcome</label>
                      <select className="herd-input" value={form.calvingOutcome||''} onChange={e => setForm(f => ({...f,calvingOutcome:e.target.value}))}>
                        <option value="">— select —</option>
                        <option value="Normal birth">Normal birth</option>
                        <option value="Assisted birth">Assisted birth</option>
                        <option value="Stillbirth">Stillbirth</option>
                        <option value="Dam died">Dam died</option>
                      </select>
                    </div>
                  </div>
                </>
              )}
              <div className="herd-2col">
                <div>
                  <label className="herd-label">Date *</label>
                  <input type="date" className="herd-input" value={form.date||''} onChange={e => setForm(f => ({...f,date:e.target.value}))} max={new Date().toISOString().slice(0,10)}/>
                </div>
                <div>
                  <label className="herd-label">Cost (TZS)</label>
                  <input type="number" className="herd-input" min="0" value={form.cost||''} onChange={e => setForm(f => ({...f,cost:e.target.value}))} placeholder="0"/>
                </div>
              </div>
              <label className="herd-label">Vet / AI Technician</label>
              <input className="herd-input" placeholder="e.g. AI Tech Musa" value={form.vet||''} onChange={e => setForm(f => ({...f,vet:e.target.value}))}/>
            </>
          )}

          {/* ── Production event ── */}
          {form.type === 'production' && (
            <>
              <label className="herd-label">{isDairy ? 'Milk Yield *' : 'Live Weight *'}</label>
              <div className="herd-2col">
                <input type="number" className="herd-input" min="0" step="0.1" placeholder={isDairy?'e.g. 8.5':'e.g. 320'} value={form.value||''} onChange={e => setForm(f => ({...f,value:e.target.value}))}/>
                <select className="herd-input" value={form.unit||'litres'} onChange={e => setForm(f => ({...f,unit:e.target.value}))}>
                  {isDairy ? ['litres','kg'].map(u=><option key={u} value={u}>{u}</option>) : ['kg','lbs'].map(u=><option key={u} value={u}>{u}</option>)}
                </select>
              </div>
              {isDairy && (
                <>
                  <label className="herd-label">Session</label>
                  <div className="herd-row">
                    {['AM','PM','Total (day)'].map(s => (
                      <button key={s} type="button"
                        className={`herd-chip${form.session===s?' active':''}`}
                        onClick={() => setForm(f => ({...f,session:s}))}>
                        {s}
                      </button>
                    ))}
                  </div>
                  <label className="herd-label">Milk Quality</label>
                  <select className="herd-input" value={form.milkQuality||''} onChange={e => setForm(f => ({...f,milkQuality:e.target.value}))}>
                    <option value="">— optional —</option>
                    <option value="Normal">Normal</option>
                    <option value="Mastitis (watery)">Mastitis (watery)</option>
                    <option value="Bloody">Bloody</option>
                    <option value="Off-colour">Off-colour</option>
                  </select>
                </>
              )}
              <div className="herd-2col">
                <div>
                  <label className="herd-label">Date *</label>
                  <input type="date" className="herd-input" value={form.date||''} onChange={e => setForm(f => ({...f,date:e.target.value}))} max={new Date().toISOString().slice(0,10)}/>
                </div>
                {!isDairy && (
                  <div>
                    <label className="herd-label">Body Condition Score (1-9)</label>
                    <input type="number" className="herd-input" min="1" max="9" step="0.5" placeholder="e.g. 5" value={form.bcs||''} onChange={e => setForm(f => ({...f,bcs:e.target.value}))}/>
                  </div>
                )}
              </div>
            </>
          )}

          {/* Shared notes */}
          <label className="herd-label">Notes</label>
          <textarea className="herd-input" rows={2} placeholder="Any observations…" value={form.notes||''} onChange={e => setForm(f => ({...f,notes:e.target.value}))} style={{resize:'vertical'}}/>

          <button className="herd-save-btn"
            disabled={saving || !form.date || (form.type==='production'&&!form.value)}
            onClick={() => saveEvent(form)}>
            {saving ? 'Saving…' : 'Save Event'}
          </button>
        </div>
      </div>
    );
  }

  // ── ADD LEASE ─────────────────────────────────────────────────────────────────────
  if (view === 'addLease' && selected) {
    return (
      <div className="herd-wrap">
        <div className="herd-nav-back">
          <button onClick={() => { setView('detail'); setDetailSec('lease'); }}>← Lease</button>
          <span>{form.id ? 'Edit Lease' : 'Add Lease / HP'}</span>
        </div>
        <div className="herd-form">
          <label className="herd-label">Lender Name *</label>
          <input className="herd-input" placeholder="e.g. AF Lease, KCB, CRDB" value={form.lenderName||''} onChange={e => setForm(f => ({...f,lenderName:e.target.value}))}/>

          <div className="herd-2col">
            <div>
              <label className="herd-label">Principal (TZS) *</label>
              <input type="number" className="herd-input" min="0" placeholder="e.g. 2500000" value={form.principalTzs||''} onChange={e => setForm(f => ({...f,principalTzs:e.target.value}))}/>
            </div>
            <div>
              <label className="herd-label">Interest Rate (% p.a.)</label>
              <input type="number" className="herd-input" min="0" max="100" step="0.1" placeholder="e.g. 18" value={form.interestRate||''} onChange={e => setForm(f => ({...f,interestRate:e.target.value}))}/>
            </div>
          </div>

          <div className="herd-2col">
            <div>
              <label className="herd-label">Total Instalments</label>
              <input type="number" className="herd-input" min="1" max="120" placeholder="e.g. 24" value={form.totalInstalments||''} onChange={e => setForm(f => ({...f,totalInstalments:e.target.value}))}/>
            </div>
            <div>
              <label className="herd-label">Instalment Amount (TZS)</label>
              <input type="number" className="herd-input" min="0" placeholder="e.g. 125000" value={form.instalmentAmountTzs||''} onChange={e => setForm(f => ({...f,instalmentAmountTzs:e.target.value}))}/>
            </div>
          </div>

          <div className="herd-2col">
            <div>
              <label className="herd-label">Start Date</label>
              <input type="date" className="herd-input" value={form.startDate||''} onChange={e => setForm(f => ({...f,startDate:e.target.value}))}/>
            </div>
            <div>
              <label className="herd-label">Frequency</label>
              <select className="herd-input" value={form.frequency||'monthly'} onChange={e => setForm(f => ({...f,frequency:e.target.value}))}>
                <option value="monthly">Monthly</option>
                <option value="quarterly">Quarterly</option>
                <option value="bi-annual">Bi-annual</option>
                <option value="annual">Annual</option>
              </select>
            </div>
          </div>

          <label className="herd-label">Contract / Reference Number</label>
          <input className="herd-input" placeholder="e.g. AFL-2024-00123" value={form.contractRef||''} onChange={e => setForm(f => ({...f,contractRef:e.target.value}))}/>

          <label className="herd-label">Notes</label>
          <textarea className="herd-input" rows={2} value={form.notes||''} onChange={e => setForm(f => ({...f,notes:e.target.value}))} style={{resize:'vertical'}}/>

          <button className="herd-save-btn"
            disabled={saving || !form.lenderName || !form.principalTzs}
            onClick={() => saveLease(form)}>
            {saving ? 'Saving…' : (form.id ? 'Update Lease' : 'Save Lease')}
          </button>
        </div>
      </div>
    );
  }

  // ── RECORD LEASE PAYMENT ──────────────────────────────────────────────────────────
  if (view === 'addPay' && selected) {
    const lease = leases.find(l => l.animalId === selected.id);
    return (
      <div className="herd-wrap">
        <div className="herd-nav-back">
          <button onClick={() => { setView('detail'); setDetailSec('lease'); }}>← Lease</button>
          <span>Record Payment</span>
        </div>
        <div className="herd-form">
          <label className="herd-label">Amount Paid (TZS) *</label>
          <input type="number" className="herd-input" min="0" placeholder={`e.g. ${Number(lease?.instalmentAmountTzs||0).toLocaleString()}`} value={form.amountTzs||''} onChange={e => setForm(f => ({...f,amountTzs:e.target.value}))}/>

          <div className="herd-2col">
            <div>
              <label className="herd-label">Payment Date *</label>
              <input type="date" className="herd-input" value={form.payDate||''} onChange={e => setForm(f => ({...f,payDate:e.target.value}))} max={new Date().toISOString().slice(0,10)}/>
            </div>
            <div>
              <label className="herd-label">Payment Method</label>
              <select className="herd-input" value={form.method||''} onChange={e => setForm(f => ({...f,method:e.target.value}))}>
                <option value="">— select —</option>
                <option value="M-Pesa">M-Pesa</option>
                <option value="Tigo Pesa">Tigo Pesa</option>
                <option value="Airtel Money">Airtel Money</option>
                <option value="Bank transfer">Bank transfer</option>
                <option value="Cash">Cash</option>
              </select>
            </div>
          </div>

          <label className="herd-label">Reference / Receipt No.</label>
          <input className="herd-input" placeholder="e.g. MP240521001" value={form.ref||''} onChange={e => setForm(f => ({...f,ref:e.target.value}))}/>

          <label className="herd-label">Notes</label>
          <textarea className="herd-input" rows={2} value={form.notes||''} onChange={e => setForm(f => ({...f,notes:e.target.value}))} style={{resize:'vertical'}}/>

          <button className="herd-save-btn"
            disabled={saving || !form.amountTzs || !form.payDate}
            onClick={async () => {
              setSaving(true);
              await addLeasePayment(lease, { amountTzs: Number(form.amountTzs), payDate: form.payDate, method: form.method, ref: form.ref, notes: form.notes });
              setSaving(false);
              setView('detail');
              setDetailSec('lease');
            }}>
            {saving ? 'Saving…' : 'Record Payment'}
          </button>
        </div>
      </div>
    );
  }

  return null;
}

// ─── Main App ───────────────────────────────────────────────────────────────────────
// AppInner holds all state and UI. Wrapped by the ErrorBoundary export below so any
// uncaught render error shows the fallback screen rather than a blank page.
// ─── ProductCard ────────────────────────────────────────────────────────────────────
// Memoized so the market grid only re-renders cards whose props actually changed.
// Handlers (onSelect, onFavorite, onAddToCart) must be stable refs (useCallback) to
// prevent defeating the memo — they are defined with useCallback in AppInner.
const ProductCard = React.memo(function ProductCard({
  p, isFav, inCart: alreadyInCart, stock, cur, onSelect, onToggleFav, onAddToCart, isAlerted, onToggleAlert, country,
}) {
  const waMsg = encodeURIComponent(`Habari! Nataka kununua ${p.name} kutoka ${p.farm}. Je, una stock?`);
  const waHref = `https://wa.me/${p.farmerPhone?.replace(/\D/g,"")}?text=${waMsg}`;
  const saveTZS = p.marketPrice && p.marketPrice > p.tzsPrice ? p.marketPrice - p.tzsPrice : 0;

  return (
    <div className="card" onClick={() => onSelect(p)}>
      <div className="card-img">
        {p.emoji}
        {p.organic  && <span className="badge-org">Organic</span>}
        {p.verified && <span className="badge-ver">★ Verified</span>}
        {p.wholesale?.length > 0 && <span className="badge-bulk">Bulk ↓</span>}
        {p.videoUrl  && <span className="card-video-pill">▶ Video</span>}
        {saveTZS > 0 && <span className="card-save-badge">Save {Math.round(saveTZS/1000)}k</span>}
        {stock <= 0  && <span className="notify-pill">🔔 Alert me</span>}
        <button
          className={`fav-btn${isFav ? " fav-active" : ""}`}
          aria-label={isFav ? "Remove from saved" : "Save product"}
          aria-pressed={isFav}
          onClick={e => { e.stopPropagation(); onToggleFav(p.id); }}
        >{isFav ? "❤️" : "🤍"}</button>
      </div>
      <div className="card-body">
        <div className="card-name">{p.name}</div>
        <div className="card-farmer">🌱 {p.farmer}</div>
        <div className="card-meta">
          <div>
            <div className="card-price">{fmt(p.tzsPrice, cur)} <span>/{p.unit}</span></div>
            {cur !== "TZS" && <div className="card-tzs">TZS {p.tzsPrice.toLocaleString()}</div>}
          </div>
          <button
            className={`card-add${alreadyInCart ? " in" : ""}`}
            disabled={!alreadyInCart && stock <= 0}
            onClick={e => { e.stopPropagation(); onAddToCart(p); }}>
            {alreadyInCart ? "✓ In Cart" : stock <= 0 ? "Sold Out" : "+ Add"}
          </button>
          <StockBadge qty={stock}/>
        </div>
        <div className="card-dist">📍 {p.dist} · ⭐ {p.rating} · {p.sales}+ orders</div>
        {stock > 0 && <div className="card-eta">{calcETA(p.dist)}</div>}
        {stock <= 0 && (
          <button className={`notify-btn${isAlerted ? " active" : ""}`}
                  onClick={e => { e.stopPropagation(); onToggleAlert(p.id); }}>
            {isAlerted ? "🔔 Alert set" : "🔕 Notify when back"}
          </button>
        )}
      </div>
      {p.farmerPhone && (
        <div className="card-wa-row">
          <a
            href={waHref}
            className="wa-btn"
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`Chat with ${p.farmer} on WhatsApp`}
            onClick={e => e.stopPropagation()}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.570-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.890-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413Z"/></svg>
            WhatsApp
          </a>
        </div>
      )}
    </div>
  );
});

function AppInner() {
const [userRole, setUserRole]           = useState(() => loadState()?.userRole || null);
const [consentGiven, setConsentGiven]   = useState(() => loadState()?.consentGiven || false);

const [tab, setTab]                     = useState("market");

// ── Referee form detection — must be checked before anything else renders ─────
const _urlParams = new URLSearchParams(window.location.search);
const _refereeToken = _urlParams.get('referee');
const _refereeAppName = _urlParams.get('name') ? decodeURIComponent(_urlParams.get('name')) : '';
const [darkMode, setDarkMode] = React.useState(() => {
  const saved = localStorage.getItem('asf_dark_mode');
  if (saved !== null) return saved === 'true';
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
});
const [favorites, setFavorites] = React.useState(() => {
  try {
    const raw = localStorage.getItem('asf_favorites');
    const parsed = raw ? JSON.parse(raw) : null;
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch { return new Set(); }
});
const toggleFavorite = useCallback(id => {
  setFavorites(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    localStorage.setItem('asf_favorites', JSON.stringify([...next]));
    return next;
  });
}, []);
const handleSelect = useCallback(p => { setSelected(p); trackView(p); }, [trackView]);

// ── Farmer onboarding gate ──────────────────────────────────────────────────
// Tracks whether the logged-in farmer has completed the onboarding wizard.
// In demo mode: auto-approved. In production: stays "pending" until admin approves.
const [farmerOnboarded, setFarmerOnboarded] = useState(() => {
  try { return localStorage.getItem("asf_farmer_status") === "approved"; }
  catch { return false; }
});
const handleFarmerApproved = useCallback(() => {
  try { localStorage.setItem("asf_farmer_status", "approved"); } catch { /* quota */ }
  setFarmerOnboarded(true);
}, []);

// ── Farmer first-time tour ──────────────────────────────────────────────────
const [farmerTourSeen, setFarmerTourSeen] = useState(() => {
  try { return localStorage.getItem("asf_farmer_tour_seen") === "1"; }
  catch { return false; }
});
const dismissFarmerTour = useCallback(() => {
  try { localStorage.setItem("asf_farmer_tour_seen", "1"); } catch { /* quota */ }
  setFarmerTourSeen(true);
}, []);

// ── Live order tracking map ─────────────────────────────────────────────────
const [mapOrder, setMapOrder] = useState(null);

// ── Saved address selection in cart ────────────────────────────────────────
const [selectedAddressId, setSelectedAddressId] = useState(null);

// ── Stock alerts ─────────────────────────────────────────────────────────────
const { alerts: stockAlerts, toggle: toggleStockAlert } = useStockAlerts();

// ── Recently viewed ──────────────────────────────────────────────────────────
const { recent: recentlyViewed, trackView } = useRecentlyViewed();

// ── Chama group buy ──────────────────────────────────────────────────────────
const [chamaOpen, setChamaOpen] = useState(false);

// ── Push notification opt-in ────────────────────────────────────────────────
const [pushDismissed, setPushDismissed] = useState(() => {
  try { return localStorage.getItem("asf_push_dismissed") === "1"; } catch { return false; }
});
const { state: pushState, subscribe: subscribePush } = usePushSubscription(!!userRole);
const showPushBanner = userRole && !pushDismissed && pushState === "prompted";
const dismissPushBanner = useCallback(() => {
  try { localStorage.setItem("asf_push_dismissed", "1"); } catch { /* quota */ }
  setPushDismissed(true);
}, []);
// ── Sprint 3: Scroll position memory ── each tab remembers where you left off
const scrollPositions = useRef({});          // { [tabId]: scrollTop }
const switchTab = useCallback((newTab) => {
// Save current position before leaving
if (appRef.current) scrollPositions.current[tab] = appRef.current.scrollTop;
setTab(newTab);
}, [tab]);
const [country, setCountry]             = useState(() => loadState()?.country || "TZ");
const [cur, setCur]                     = useState(() => loadState()?.cur || "TZS");
const [curOpen, setCurOpen]             = useState(false);
const [filter, setFilter]               = useState("All");
const [selected, setSelected]           = useState(null);
const modalRef = useRef(null); // focus trap for product modal
const [cart, setCart]                   = useState(() => loadState()?.cart || []);
const [qty, setQty]                     = useState(() => loadState()?.qty || {});
const [cartOpen, setCartOpen]           = useState(false);
const [payOpen, setPayOpen]             = useState(false);
const [posted, setPosted]               = useState(false);
const [formErr, setFormErr]             = useState({});
const [toggles, setToggles]             = useState({ available:true, organic:false, delivery:true });
const [ships, setShips]                 = useState([]);
const [orders, setOrders]               = useState([]);
const [riders, setRiders]               = useState([]);
const [apiError, setApiError]           = useState(null);
const [sseConnected, setSseConnected]   = useState(false);
const [riderView, setRiderView]         = useState("rider");
const [activeRider, setActiveRider]     = useState("R01");
const [toast, setToast]                 = useState(null);
const [undoItem, setUndoItem]           = useState(null);
const [tipVisible, setTipVisible]       = useState(true);
const [tabLoading, setTabLoading]       = useState(true);
const [showScroll, setShowScroll]       = useState(false);
const [search, setSearch]               = useState("");
const [form, setForm]                   = useState({ crop:"", price:"", unit:"KG", harvest:"", qty:"" });
const [harvestPhotos, setHarvestPhotos] = useState([]); // [{ url, name, size }]
const [couponCode, setCouponCode]       = useState("");
const [couponResult, setCouponResult]   = useState(null);
// Also persisted to localStorage so they survive page refresh.
const [apSubmissions, setApSubmissions] = useState(() => {
const saved = loadState()?.apSubmissions;
return (saved && saved.length > 0) ? saved : AP_SUBMISSIONS_INIT;
});
const [loyaltyPts, setLoyaltyPts]       = useState(() => loadState()?.loyaltyPts || 240);
const [reviews,    setReviews]          = useState(REVIEWS_INIT);
const [reviewPrompt, setReviewPrompt]   = useState(null); // order to review, or null
const [riderLocation, setRiderLocation] = useState(null);
const [geoLoading, setGeoLoading]       = useState(false);
const [isOnline, setIsOnline]           = useState(navigator.onLine);
const { canInstall, isIOS: isIOSBanner, swReady, promptInstall, dismiss: dismissPWA } = usePWA();
const { fxRevision, fxMeta } = useFXRates();
const { t, lang, setLang } = useTranslation(); // Swahili / English toggle

const dropRef  = useRef(null);
const appRef   = useRef(null);
useEffect(() => {
const h = e => {
if (e.key === "Escape") setCurOpen(false);
if (dropRef.current && !dropRef.current.contains(e.target)) setCurOpen(false);
};
document.addEventListener("keydown", h);
document.addEventListener("mousedown", h);
return () => { document.removeEventListener("keydown", h); document.removeEventListener("mousedown", h); };
}, []);
useEffect(() => {
setTabLoading(true);
const t = setTimeout(() => {
setTabLoading(false);
// Restore saved scroll position for this tab (after shimmer clears)
const saved = scrollPositions.current[tab] ?? 0;
if (appRef.current) appRef.current.scrollTo({ top: saved, behavior: "instant" });
}, 500);
analytics.pageView(tab, { country, userRole });
return () => clearTimeout(t);
}, [tab]);

const cartLineCount = cart.length;
// Update document title with cart count so PWA task-switcher shows badge
useEffect(() => {
const base = "Asiel Farm Shop";
document.title = cartLineCount > 0 ? `(${cartLineCount}) ${base}` : base;
}, [cartLineCount]);

// Sync dark mode preference to DOM and localStorage
useEffect(() => {
  document.documentElement.setAttribute('data-theme', darkMode ? 'dark' : 'light');
  localStorage.setItem('asf_dark_mode', darkMode);
}, [darkMode]);


// Scroll-to-top listener
useEffect(() => {
const el = appRef.current;
if (!el) return;
const onScroll = () => setShowScroll(el.scrollTop > 280);
el.addEventListener("scroll", onScroll);
return () => el.removeEventListener("scroll", onScroll);
}, []);
const showToast = useCallback(msg => { setToast(msg); setTimeout(() => setToast(null), TOAST_DISMISS_MS); }, []);

// ── API bootstrap — fetch live data on mount and whenever country switches ──
// Falls back to static mock arrays automatically when API_BASE is empty (demo mode).
useEffect(() => {
let cancelled = false;
async function bootstrap() {
try {
const [fetchedOrders, fetchedRiders, fetchedShips] = await Promise.all([
apiService.getOrders(country),
apiService.getRiders(country),
apiService.getShipments(country),
]);
if (cancelled) return;
setOrders(fetchedOrders);
setRiders(fetchedRiders);
setShips(fetchedShips);
setApiError(null);
} catch (err) {
if (cancelled) return;
// Graceful degradation — fall back to static data so app stays usable
setOrders(ORDERS_INIT.filter(o => o.country === country));
setRiders(RIDERS_DATA);
setShips(SHIPS_INIT);
setApiError(err.message);
log.warn("[App] API bootstrap failed — using mock data:", err.message);
}
}
bootstrap();
return () => { cancelled = true; };
}, [country]);

// ── Real-time updates via SSE ──
// Updates order/rider/shipment state as events arrive from the server.
// In demo mode, synthetic events fire every 12 s showing realistic state changes.
const updateShip = useCallback((id, patch) =>
setShips(prev => prev.map(s => s.id === id ? { ...s, ...patch } : s)), []);
const updateRider = useCallback((id, patch) =>
setRiders(prev => prev.map(r => r.id === id ? { ...r, ...patch } : r)), []);

const { connected: sseConn } = useSSE(country, {
onOrderUpdate:    patch => {
setOrders(prev => prev.map(o => o.id === patch.id ? { ...o, ...patch } : o));
showToast(`📦 ${patch.id} → ${patch.status}`);
},
onRiderUpdate:    patch => updateRider(patch.id, patch),
onShipmentUpdate: patch => { updateShip(patch.id, patch); },
onStockUpdate:    updates => syncStock(updates), // { [productId]: newQty }
onRiderLocation:  ({ orderId, lat, lng }) => {
  // Update the live map if it's open for this order (lat/lng stored for future Leaflet use)
  setMapOrder(prev => prev?.id === orderId ? { ...prev, _lat: lat, _lng: lng } : prev);
},
});

// Sync SSE connection status into state for the UI indicator
useEffect(() => { setSseConnected(sseConn); }, [sseConn]);
// showToast is now in scope; added to dep array so React knows about the dependency.
useEffect(() => {
const onOnline  = () => { setIsOnline(true);  showToast(t("toast.online")); };
const onOffline = () => { setIsOnline(false); showToast(t("toast.offline")); };
window.addEventListener("online",  onOnline);
window.addEventListener("offline", onOffline);
return () => { window.removeEventListener("online", onOnline); window.removeEventListener("offline", onOffline); };
}, [showToast]);
useEffect(() => {
saveState({ cart, qty, loyaltyPts, country, cur, userRole, consentGiven, apSubmissions });
// Debounced backend sync — fires 3 s after last change when authenticated
scheduledBackendSync({ cart, qty, loyaltyPts, country, cur, consentGiven });
}, [cart, qty, loyaltyPts, country, cur, userRole, consentGiven, apSubmissions]);

const scrollTop = useCallback(() => appRef.current?.scrollTo({ top:0, behavior:"smooth" }), []);

// ── WCAG 2.1: Focus traps for all modal dialogs ──
useFocusTrap(modalRef, !!selected);

// Fallback to TZS if cur is a stale/unknown code from localStorage
const curMeta   = CURRENCIES.find(c => c.code === cur) || CURRENCIES[0];
const DELIV_TZS = getCfg(country).deliveryFee;
// Ticker re-computes whenever fxRevision changes (after a live rate refresh)
const ticker = useMemo(() =>
CURRENCIES.filter(c => c.code !== "TZS" && FX[c.code] != null).map(c => ({
...c,
rate: (FX[c.code]).toLocaleString(undefined, { minimumFractionDigits:c.decimals+2, maximumFractionDigits:c.decimals+2 })
})),
[fxRevision]); // eslint-disable-line

// Products loaded from API (falls back to static PRODUCTS in demo mode)
const { data: apiProducts, loading: productsLoading } = useApi(
() => apiService.getProducts(country),
[country]
);
const allProducts = apiProducts ?? PRODUCTS.filter(p => p.country === country);

// Stock tracking — client-side reservation map seeded from product.stockQty
const { stockMap, reserveQty, releaseQty, syncStock } = useStock(allProducts);

const visible = useMemo(() => allProducts.filter(p => {
const q = search.toLowerCase();
if (q && !p.name.toLowerCase().includes(q) && !p.farmer.toLowerCase().includes(q)) return false;
if (filter === "Organic"  && !p.organic)              return false;
if (filter === "Verified" && !p.verified)             return false;
if (filter === "< 30 km"  && parseInt(p.dist, 10) >= 30) return false;
if (filter === "< 60 km"  && parseInt(p.dist, 10) >= 60) return false;
if (filter === "❤️ Saved" && !favorites.has(p.id)) return false;
if (filter === "Wholesale" && !(p.wholesale?.length > 0)) return false;
return true;
}), [allProducts, search, filter, favorites]);

// Cart helpers
const getQty = useCallback(id => qty[id] || 1, [qty]);
const inCart = useCallback(id => cart.some(c => c.id === id), [cart]);

const addToCart = useCallback(p => {
const available = stockMap[p.id] ?? p.stockQty ?? 999;
if (available <= 0) { showToast(t("toast.sold_out")); return; }
if (!inCart(p.id)) {
setCart(prev => [...prev, p]);
setQty(q => ({ ...q, [p.id]:1 }));
reserveQty(p.id);
analytics.capture("cart.add", { product: p.name, tzsPrice: p.tzsPrice, country });
}
setCartOpen(true); setSelected(null);
showToast(t("toast.added_to_cart"));
}, [inCart, showToast, stockMap, reserveQty, country]);
// call had no timer, second overwrote it — if React flushed between the two,
// clearTimeout() in undoRemove would receive undefined and the auto-dismiss
// would fire even after a successful undo.
const removeFromCart = useCallback(id => {
const item     = cart.find(p => p.id === id);
const savedQty = qty[id] || 1;
setCart(prev => prev.filter(p => p.id !== id));
setQty(q => { const n={...q}; delete n[id]; return n; });
releaseQty(id); // return reservation to stock map
if (undoItem?.timer) clearTimeout(undoItem.timer); // clear any previous undo timer
const undoTimer = setTimeout(() => setUndoItem(null), UNDO_WINDOW_MS);
setUndoItem({ item, savedQty, timer: undoTimer });
}, [cart, qty, releaseQty]);

const undoRemove = useCallback(() => {
if (!undoItem) return;
clearTimeout(undoItem.timer);
setCart(prev => [...prev, undoItem.item]);
setQty(q => ({ ...q, [undoItem.item.id]: undoItem.savedQty }));
setUndoItem(null);
showToast(t("toast.restored"));
}, [undoItem, showToast]);

const changeQty = useCallback((id, delta) => {
setQty(q => ({ ...q, [id]: Math.max(1, (q[id]||1) + delta) }));
}, []);
const cartTZS       = cart.reduce((s,p) => s + p.tzsPrice * getQty(p.id), 0);
const totalTZS      = cartTZS + DELIV_TZS;
const handleApplyCoupon = useCallback(() => {
if (couponResult?.valid && couponResult.code === couponCode.toUpperCase().trim()) {
  showToast("⚠️ Coupon already applied"); return;
}
const result = applyCoupon(couponCode, cartTZS);
setCouponResult(result);
if (result.valid) showToast(`${t("toast.coupon_applied")} ${fmt(result.discount,"TZS")}`);
else showToast("❌ " + result.error);
}, [couponCode, couponResult, cartTZS, showToast, t]);
const awardLoyaltyPts = useCallback((tzsSpent) => {
const pts = earnPoints(tzsSpent);
setLoyaltyPts(p => p + pts);
showToast(`+${pts} ${t("toast.loyalty_earned")}`);
}, [showToast]);
const handleGeoCheckIn = useCallback(() => {
if (!navigator.geolocation) { showToast(t("toast.geo_unsupported")); return; }
if (geoLoading) return;
setGeoLoading(true);
navigator.geolocation.getCurrentPosition(
pos => {
const { latitude: lat, longitude: lng } = pos.coords;
setRiderLocation({ lat: lat.toFixed(5), lng: lng.toFixed(5) });
setGeoLoading(false);
const hub = getCfg(country).hub.name;
const hc  = getCfg(country).hub.coords;
const dist = calcDistKm(lat, lng, hc.lat, hc.lng);
showToast(`📍 Location fixed · ${dist} km from ${hub}`);
},
() => {
const mockCoords = getCfg(country).hub.coords;
setRiderLocation({ lat: String(mockCoords.lat), lng: String(mockCoords.lng) });
setGeoLoading(false);
showToast(t("toast.geo_blocked"));
},
{ timeout:8000 }
);
}, [country, geoLoading, showToast]);
const handlePost = useCallback(() => {
const errs = {};
if (!form.crop)    errs.crop = "Crop name is required";
if (!form.price)   errs.price = "Price is required";
if (!form.harvest) errs.harvest = "Harvest date is required";
if (!form.qty)     errs.qty = "Quantity is required";
if (Object.keys(errs).length) { setFormErr(errs); showToast(t("toast.fill_fields")); return; }
setFormErr({});
// Wire toggles — farmer's availability, organic, and hub-dropoff settings
const listing = {
crop:     form.crop,
price:    form.price,
unit:     form.unit,
harvest:  form.harvest,
qty:      form.qty,
available: toggles.available,
organic:   toggles.organic,
hubReady:  toggles.delivery,
photos:    harvestPhotos.map(p => p.url), // CDN URLs sent to backend
country,
};
// TODO: apiService.createListing(listing) — backend endpoint pending
analytics.capture("farmer.listing_submitted", { crop: form.crop, country, organic: toggles.organic });
setPosted(true);
setForm({ crop:"", price:"", unit:"KG", harvest:"", qty:"" });
setFormErr({});
setHarvestPhotos([]);
setTimeout(() => setPosted(false), 5000);
showToast(t("toast.listing_sub"));
}, [form, toggles, country, showToast]);

// Rider actions
const updateOrder   = useCallback((id,patch) => setOrders(prev => prev.map(o => o.id===id?{...o,...patch}:o)), []);
const riderAccept   = useCallback(id => { updateOrder(id,{status:"assigned",  riderId:activeRider}); showToast(t("toast.order_accepted")); }, [updateOrder, activeRider, showToast]);
const riderPickup   = useCallback(id => { updateOrder(id,{status:"picked-up", riderId:activeRider}); showToast(t("toast.picked_up")); }, [updateOrder, activeRider, showToast]);
const riderComplete = useCallback(id => {
updateOrder(id, { status:"delivered", riderId:activeRider });
showToast(t("toast.delivered"));
// Prompt customer to review 30 s after delivery (demo: 5 s so testers can see it)
const order = orders.find(o => o.id === id);
if (order) {
const delay = API_BASE ? 30000 : 5000;
setTimeout(() => setReviewPrompt(order), delay);
}
}, [updateOrder, activeRider, showToast, orders]);
const adminAssign   = useCallback((oid,rid) => { if(rid){updateOrder(oid,{status:"assigned",riderId:rid}); showToast("🚴 Rider assigned!");} }, [updateOrder, showToast]);
const adminUnassign = useCallback(oid => { updateOrder(oid,{status:"available",riderId:null}); showToast("↩️ " + t("toast.removed")); }, [updateOrder, showToast]);

const myRider   = riders.find(r => r.id === activeRider);
const myOrders  = orders.filter(o => o.riderId===activeRider || (o.status==="available" && o.country===country));
const allOrders = orders.filter(o => o.country===country);

// Referee form intercept — render standalone if ?referee= is in URL
if (_refereeToken) {
  return (
    <>
      <style>{css}</style>
      <AFLeaseRefereeForm
        token={_refereeToken}
        applicantName={_refereeAppName}
        showToast={showToast}
      />
    </>
  );
}

return (
<>
<style>{css}</style>

  {!userRole && (
    <LoginScreen onLogin={role => {
      setUserRole(role);
      // Route to the first allowed tab for this role
      const allowed = ROLES[role].tabs;
      if (!allowed.includes(tab)) switchTab(allowed[0]);
      // Hydrate app state from backend — merges server cart/loyalty/prefs
      // into localStorage and then updates React state via setters
      hydrateFromBackend({
        setCart, setQty, setLoyaltyPts, setCountry, setCur, setConsentGiven,
      }).catch(err => log.warn("[hydrate] backend sync failed:", err.message));
    }}/>
  )}

  {userRole && !consentGiven && (
    <ConsentDialog onAccept={() => setConsentGiven(true)}/>
  )}

  {/* Farmer onboarding gate — shown after consent, before the main app */}
  {userRole === "farmer" && consentGiven && !farmerOnboarded && (
    <FarmerOnboarding country={country} onApproved={handleFarmerApproved}/>
  )}

  <div className="app" ref={appRef} id="main-content"
    style={userRole === "farmer" && consentGiven && !farmerOnboarded ? {display:"none"} : {}}>
    {/* Skip-to-content for keyboard users */}
    <a className="skip-link" href="#main-content">Skip to main content</a>

    {/* ── TOP NAV ── */}
    <nav className="nav" aria-label="Main navigation">
      <div className="nav-logo">
        <img src={LOGO_NAV} alt="Asiel Farms" width="42" height="42" style={{height:42,width:42,borderRadius:8,objectFit:"cover",marginRight:8,verticalAlign:"middle",boxShadow:"0 2px 8px rgba(0,0,0,.3)"}}/>
        <span style={{verticalAlign:"middle",lineHeight:1}}>Asiel<span style={{color:"var(--mint)"}}> Farm Shop</span></span>
      </div>
      <div className="nav-right">
        {/* App version — shown only in demo/dev mode */}
      {!API_BASE && <span style={{fontSize:9,color:"rgba(255,255,255,.3)",marginRight:4,letterSpacing:.5}}>v{APP_VERSION}</span>}
      {/* SSE live indicator — pulses green when real-time stream is connected */}
        <span title={sseConnected ? "Live updates connected" : "Not connected"} style={{display:"flex",alignItems:"center",fontSize:10,color:"rgba(255,255,255,.6)"}}>
          <span className={`sse-dot${sseConnected ? "" : " off"}`}/>
          {sseConnected ? "Live" : ""}
        </span>
        {/* Language toggle — SW / EN */}
        <button
          aria-label={`Switch language — currently ${lang === "sw" ? "Kiswahili" : "English"}`}
          onClick={() => setLang(lang === "sw" ? "en" : "sw")}
          style={{background:"rgba(255,255,255,.12)",border:"1px solid rgba(255,255,255,.2)",
                  borderRadius:14,padding:"3px 9px",fontSize:10,fontWeight:700,
                  color:"rgba(255,255,255,.8)",cursor:"pointer",fontFamily:"var(--font-body)"}}>
          {lang === "sw" ? "SW 🇹🇿" : "EN 🌍"}
        </button>
        {/* Dark mode toggle */}
        <button
          aria-label={darkMode ? "Switch to light mode" : "Switch to dark mode"}
          onClick={() => setDarkMode(d => !d)}
          title={darkMode ? "Light mode" : "Dark mode"}
          style={{background:"rgba(255,255,255,.12)",border:"1px solid rgba(255,255,255,.2)",
                  borderRadius:14,padding:"3px 9px",fontSize:13,cursor:"pointer",
                  color:"rgba(255,255,255,.85)",lineHeight:1}}>
          {darkMode ? "☀️" : "🌙"}
        </button>
        {userRole && (
          <button className="role-badge" title="Sign out" onClick={() => { apiService.logout(); setUserRole(null); setConsentGiven(false); _resetEB(); }}>
            {ROLES[userRole]?.icon} {ROLES[userRole]?.label}
          </button>
        )}
        <div className="country-toggle">
          {Object.entries(COUNTRY_REGISTRY).map(([code, cfg]) => (
            <button key={code}
              className={`country-opt${country===code?" active":""}${!cfg.active?" coming-soon":""}`}
              title={cfg.active ? cfg.name : `${cfg.name} — coming soon`}
              onClick={() => {
                if (!cfg.active) return;
                setCountry(code);
                setCur(cfg.defaultCur);
              }}>
              {cfg.flag} {code}
            </button>
          ))}
        </div>
        <div className="cur-picker" ref={dropRef}>
          <button className="cur-btn"
                  aria-label={`Select display currency — currently ${curMeta.code}`}
                  aria-expanded={curOpen}
                  aria-haspopup="listbox"
                  onClick={() => setCurOpen(o => !o)}>
            {curMeta.flag} {curMeta.symbol}&nbsp;{curMeta.code}
            <span className="cur-caret">{curOpen?"▲":"▼"}</span>
          </button>
          {curOpen && (
            <div className="cur-drop">
              <div className="cur-drop-title">Display Currency</div>
              {CURRENCIES.map(c => (
                <div key={c.code} className={`cur-opt${cur===c.code?" sel":""}`}
                  onClick={() => { setCur(c.code); setCurOpen(false); }}>
                  <span className="cur-flag">{c.flag}</span>
                  <span className="cur-code">{c.code}</span>
                  <span className="cur-label">{c.label}</span>
                  <span className="cur-sym">{c.symbol}</span>
                  {c.code==="TZS" && <span className="cur-base-tag">BASE</span>}
                </div>
              ))}
            </div>
          )}
        </div>
        <button className="cart-btn"
                aria-label={`Shopping cart${cartLineCount > 0 ? `, ${cartLineCount} item${cartLineCount > 1 ? "s" : ""}` : ", empty"}`}
                aria-expanded={cartOpen}
                onClick={() => setCartOpen(o => !o)}>
          🛒{cartLineCount>0 && <span className="cart-badge">{cartLineCount}</span>}
        </button>
      </div>
    </nav>

    {userRole && consentGiven && !isOnline && (
      <div className="offline-banner">📵 You are offline — changes saved locally and will sync when reconnected.</div>
    )}
    {apiError && isOnline && (
      <div className="offline-banner" style={{background:"#856404"}}>
        ⚠️ Running in demo mode — API unreachable. Set API_BASE to connect your backend.
      </div>
    )}

    {/* ── Push notification opt-in banner ── */}
    {showPushBanner && (
      <div className="push-banner">
        <span style={{fontSize:24}}>🔔</span>
        <div className="push-banner-text">
          <strong>Enable order notifications</strong>
          Get notified when your rider is on the way and when your order arrives.
        </div>
        <button className="push-allow-btn" onClick={() => { subscribePush(); dismissPushBanner(); }}>
          Allow
        </button>
        <button className="push-dismiss-btn" aria-label="Dismiss" onClick={dismissPushBanner}>×</button>
      </div>
    )}

    {/* ── PWA install prompt ── */}
    {canInstall && (
      <div className="pwa-banner" role="complementary" aria-label="Install app">
        <span style={{fontSize:28}}>📲</span>
        <div className="pwa-banner-text">
          <strong>Install Asiel Farm Shop</strong>
          {isIOSBanner
            ? <span>Tap <strong>Share</strong> then <strong>"Add to Home Screen"</strong></span>
            : <span>Works offline · No app store needed · Instant access</span>}
          {swReady && <span className="pwa-sw-badge"><span className="pwa-sw-dot"/>  Offline ready</span>}
        </div>
        {!isIOSBanner && (
          <button className="pwa-banner-install" onClick={promptInstall}>Install</button>
        )}
        <button className="pwa-banner-dismiss" onClick={dismissPWA} aria-label="Dismiss install prompt">×</button>
      </div>
    )}

    {/* FX TICKER */}
    <div className="fx-bar" role="complementary" aria-label="Live currency exchange rates">
      <span className="fx-lbl">1 TZS =</span>
      {ticker.map(c => (
        <span key={c.code} className="fx-tag">{c.flag} <strong>{c.rate} {c.code}</strong></span>
      ))}
      <span style={{marginLeft:"auto",fontSize:10,color:"rgba(255,255,255,.25)",flexShrink:0,display:"flex",alignItems:"center",gap:5}}>
        <span style={{
          background: fxMeta.source === "live" ? "var(--leaf)" : "rgba(255,255,255,.15)",
          color: fxMeta.source === "live" ? "var(--forest)" : "rgba(255,255,255,.4)",
          borderRadius:6, padding:"1px 5px", fontWeight:700, fontSize:9,
        }}>
          {fxMeta.source === "live" ? "LIVE" : "SEED"}
        </span>
        Base: TZS
      </span>
    </div>

    {/* ══════════ MARKETPLACE ══════════ */}
    {tab === "market" && (
      <main id="main-content" aria-label="Fresh produce marketplace">
        <div className="hero">
          <div className="hero-tag">{t("hero.tag")} · {getCfg(country).city}</div>
          <div style={{display:"flex",alignItems:"center",gap:16,marginBottom:12}}>
            <img src={LOGO_HERO} alt="Asiel Farms" loading="lazy" style={{
              width:80,height:80,borderRadius:16,objectFit:"cover",flexShrink:0,
              boxShadow:"0 4px 20px rgba(0,0,0,.3)",border:"3px solid rgba(255,255,255,.25)"
            }}/>
            <div>
              <h1>{t("hero.title")}</h1>
              <p style={{marginTop:4}}>{t("hero.subtitle")}</p>
            </div>
          </div>
          <div className="hero-cur-badge">{curMeta.flag} Prices in {curMeta.code} ({curMeta.symbol}) · Base: TZS</div>
          <div className="hero-search">
            <div className="search-wrap">
              <input id="market-search"
                     aria-label={t("hero.search.placeholder")}
                     placeholder={t("hero.search.placeholder")}
                     value={search} onChange={e => setSearch(e.target.value)}/>
              {search && <button className="search-clear" aria-label="Clear search" onClick={() => setSearch("")}>✕</button>}
              <VoiceMic lang={lang === "sw" ? "sw-TZ" : "en-KE"} onResult={t => setSearch(t)} title="Search by voice"/>
            </div>
            <button>Search</button>
          </div>
        </div>

        {tipVisible && (
          <div className="tip-banner">
            <span className="tip-icon">💡</span>
            <span><strong>Tap any product</strong> to see the farmer profile, traceability QR, and all currency prices.</span>
            <button className="tip-close" aria-label="Dismiss tip" onClick={() => setTipVisible(false)}>✕</button>
          </div>
        )}

        <div className="filter-row">
          {PRODUCT_FILTERS.map(f => (
            <button key={f} className={`chip${filter===f?" active":""}`} onClick={() => setFilter(f)}>{f}</button>
          ))}
        </div>

        <RecentlyViewed items={recentlyViewed} cur={cur} onSelect={handleSelect} allProducts={allProducts}/>
        <SeasonalCalendar country={country}/>

        <div className="sec-label">🌿 {(tabLoading||productsLoading) ? t("market.loading") : `${visible.length} ${t("market.listings")}`} · {curMeta.flag} {curMeta.code}</div>

        {(tabLoading || productsLoading) ? <ShimmerGrid/> : visible.length === 0 ? (
          <div className="empty-state">
            <div className="es-icon">🔍</div>
            <h3>No results found</h3>
            <p>Try clearing your filters or searching for a different crop or farmer name.</p>
            <button onClick={() => { setSearch(""); setFilter("All"); }}>Clear Filters</button>
          </div>
        ) : (
          <div className="grid">
            {visible.map(p => (
              <ProductCard
                key={p.id}
                p={p}
                isFav={favorites.has(p.id)}
                inCart={inCart(p.id)}
                stock={stockMap[p.id] ?? p.stockQty ?? 999}
                cur={cur}
                country={country}
                onSelect={handleSelect}
                onToggleFav={toggleFavorite}
                onAddToCart={addToCart}
                isAlerted={stockAlerts.has(p.id)}
                onToggleAlert={toggleStockAlert}
              />
            ))}
          </div>
        )}
      {/* ── Order History ── */}
        {userRole && (
          <OrderHistory
            country={country}
            cur={cur}
            onReview={order => setReviewPrompt(order)}
            onTrack={order => setMapOrder(order)}
          />
        )}

        {/* ── Referral card (authenticated users) ── */}
        {userRole && <ReferralCard showToast={showToast}/>}
      </main>
    )}
    {tab === "portal" && (
      <div className="portal">
        <h2>Post My Harvest 🌾</h2>
        <p className="sub">List produce to {getCfg(country).city} customers</p>
        {posted && <div className="success-bann">✅ Listing submitted! Visible after hub QC approval.</div>}
        {tabLoading ? <ShimmerGrid/> : (
          <>
            <div className="fcard">
              <h3>💳 Your Wallet</h3>
              <div className="wallet-row">
                <div className="wallet-icon">{getCfg(country).payments[0] === "tigopesa" ? "📲" : "📱"}</div>
                <div>
                  <div className="wallet-name">
                    {getCfg(country).payments[0] === "tigopesa" ? "Tigo Pesa / Vodacom" :
                     getCfg(country).payments[0] === "mpesa"    ? "M-Pesa" :
                     getCfg(country).payments[0] === "mtn_momo" ? "MTN MoMo" : "Mobile Money"}
                  </div>
                  <div className="wallet-num">{getCfg(country).dialPrefix} *** *** ***</div>
                </div>
                <div className="wallet-bal">{fmt(200000,cur)}</div>
              </div>
              <div style={{fontSize:11,color:"#aaa",lineHeight:1.7}}>
                Payouts automated within 2 hrs of delivery.
                {getCfg(country).vfdRequired && " TRA VFD receipt auto-generated."}
              </div>
            </div>

            {/* ── Earnings dashboard ── */}
            <EarningsDashboard cur={cur}/>

            {/* ── Payout Ledger ── */}
            <div className="fcard">
              <h3>📋 Payout Ledger</h3>
              <div style={{fontSize:11,color:"#aaa",marginBottom:12}}>
                Tap any row to see the full commission breakdown.
                {getCfg(country).vfdRequired && " VAT (18%) applied to platform commission."}
              </div>
              <PayoutLedger entries={PAYOUT_LEDGER_INIT} cur={cur} country={country}/>
            </div>
            <div className="fcard">
              <h3>📸 Harvest Photos</h3>
              <div style={{fontSize:11,color:"#aaa",marginBottom:10}}>
                Good photos get <strong style={{color:"var(--leaf)"}}>3× more orders</strong> —
                show freshness, size, and packaging clearly.
              </div>
              <PhotoUpload
                photos={harvestPhotos}
                onChange={setHarvestPhotos}
                maxPhotos={4}
              />
            </div>
            <div className="fcard">
              <h3>📋 Listing Details</h3>
              <div className="fg">
                <label htmlFor="f-crop">Crop Name *</label>
                <div style={{display:"flex",alignItems:"center",gap:6}}>
                  <input id="f-crop" className={formErr.crop?"err":""} placeholder="e.g. Roma Tomatoes"
                         aria-invalid={!!formErr.crop} aria-describedby={formErr.crop?"err-crop":undefined}
                         value={form.crop} onChange={e=>{setForm(f=>({...f,crop:e.target.value}));setFormErr(fe=>({...fe,crop:""}));}}
                         style={{flex:1}}/>
                  <VoiceMic lang={lang === "sw" ? "sw-TZ" : "en-KE"} onResult={t => { setForm(f=>({...f,crop:t})); setFormErr(fe=>({...fe,crop:""})); }} title="Say crop name"/>
                </div>
                {formErr.crop && <div id="err-crop" className="field-err" role="alert">⚠ {formErr.crop}</div>}
              </div>
              <div className="frow">
                <div className="fg">
                  <label htmlFor="f-price">Price ({sym(cur)}) *</label>
                  <input id="f-price" className={formErr.price?"err":""} type="number" placeholder="Amount"
                         aria-invalid={!!formErr.price} aria-describedby={formErr.price?"err-price":undefined}
                         value={form.price} onChange={e=>{setForm(f=>({...f,price:e.target.value}));setFormErr(fe=>({...fe,price:""}));}}/>
                  {formErr.price && <div id="err-price" className="field-err" role="alert">⚠ {formErr.price}</div>}
                </div>
                <div className="fg">
                  <label>Unit</label>
                  <select value={form.unit} onChange={e=>setForm(f=>({...f,unit:e.target.value}))}>
                    <option>KG</option><option>Bunch</option><option>Crate</option><option>Piece</option>
                  </select>
                </div>
              </div>
              {form.price && !isNaN(Number(form.price)) && Number(form.price) > 0 && (() => {
                const tzsEq = Number(form.price) / FX[cur];
                return (
                  <div className="conv-preview">
                    💱 <strong>TZS {Math.round(tzsEq).toLocaleString()} in all currencies:</strong><br/>
                    {CURRENCIES.filter(c => c.code!==cur).map(c => {
                      const out = tzsEq * FX[c.code];
                      return <span key={c.code} style={{marginRight:12}}>{c.flag} {c.symbol}{out.toLocaleString(undefined,{minimumFractionDigits:c.decimals,maximumFractionDigits:c.decimals})}</span>;
                    })}
                  </div>
                );
              })()}
              <div className="frow">
                <div className="fg">
                  <label>Harvest Date *</label>
                  <input className={formErr.harvest?"err":""} type="date" value={form.harvest} onChange={e=>{setForm(f=>({...f,harvest:e.target.value}));setFormErr(fe=>({...fe,harvest:""}));}}/>
                  {formErr.harvest && <div className="field-err">⚠ {formErr.harvest}</div>}
                </div>
                <div className="fg">
                  <label>Qty Available *</label>
                  <input className={formErr.qty?"err":""} type="number" placeholder="KG / units" value={form.qty} onChange={e=>{setForm(f=>({...f,qty:e.target.value}));setFormErr(fe=>({...fe,qty:""}));}}/>
                  {formErr.qty && <div className="field-err">⚠ {formErr.qty}</div>}
                </div>
              </div>
            </div>
            <div className="fcard">
              <h3>⚙️ Inventory Settings</h3>
              {[["available","Available for Orders","Customers can order right now"],["organic","Certified Organic",country==="TZ"?"TBS / TMDA certified":"KEPHIS / KOAN"],["delivery","Hub Drop-off Ready","I can deliver to the aggregation hub"]].map(([k,l,s]) => (
                <div key={k} className="tgl-row">
                  <div className="tgl-lbl">{l}<span>{s}</span></div>
                  <button className={`tgl${toggles[k]?" on":""}`} onClick={() => setToggles(t => ({...t,[k]:!t[k]}))}/>
                </div>
              ))}
            </div>
            <div style={{background:"#fff8e1",borderRadius:12,padding:"10px 13px",marginBottom:13,fontSize:12,borderLeft:"3px solid var(--gold)",color:"#5c3d1e"}}>
              💰 <strong>Commission:</strong> {getCfg(country).commission.label}
            </div>
            <button className="submit-btn" onClick={handlePost}>🚀 Submit Listing to Hub</button>
          </>
        )}
      </div>
    )}

    {/* ══════════ HUB MANAGER ══════════ */}
    {tab === "hub" && (
      <div className="hub">
        <h2>Aggregation Hub 🏭</h2>
        <p className="sub">{country==="TZ"?"Ubungo Collection Hub · Dar es Salaam":"Westlands Collection Hub · Nairobi"}</p>
        {tabLoading ? <ShimmerGrid/> : (
          <>
            <div className="hub-stats">
              {[["12","green","Awaiting"],["4","gold","Under QC"],["8","terra","Green-lit"]].map(([v,c,l]) => (
                <div key={l} className="hub-stat"><div className={`hsv ${c}`}>{v}</div><div className="hsl">{l}</div></div>
              ))}
            </div>
            <div className="sec-label">📦 Today's Incoming Shipments</div>
            {ships.map(s => {
              const m = SMETA[s.status];
              return (
                <div key={s.id} className="ship-card">
                  <div className="ship-emoji">{s.emoji}</div>
                  <div style={{flex:1}}>
                    <div className="ship-name">{s.product}</div>
                    <div className="ship-meta">From: <strong>{s.farmer}</strong> → {s.hub}</div>
                    <div className={`ship-status ${m.cls}`}>{m.icon} {m.label}</div>
                    {s.status==="qc" && (
                      <div className="qc-acts">
                        <button className="btn-app" onClick={() => setShips(p => p.map(x => x.id===s.id?{...x,status:"green"}:x))}>✅ Green-light</button>
                        <button className="btn-rej">❌ Reject</button>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
            <div style={{background:"white",borderRadius:14,padding:15,marginTop:8,boxShadow:"var(--shadow-sm)"}}>
              <div style={{fontWeight:600,fontSize:14,color:"var(--forest)",marginBottom:8}}>📊 QR Traceability Active</div>
              <div style={{fontSize:13,color:"#777",lineHeight:1.7}}>Every bag is tagged with a QR code linking to farm origin, harvest date, and QC officer ID. All values settled in TZS.</div>
              <div style={{marginTop:9,display:"flex",flexWrap:"wrap",gap:5}}>
                {["TZ-MRG-2026-0117","TZ-ARU-2026-0066","KE-KLF-2026-0041"].map(code=>(
                  <div key={code} style={{background:"var(--forest)",color:"white",borderRadius:7,padding:"3px 9px",fontSize:10,fontWeight:600}}>▪ {code}</div>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    )}

    {/* ══════════ RIDER PORTAL ══════════ */}
    {tab === "rider" && (
      <div className="rider">
        <div className="rider-head">
          <h2>🚴 Delivery Portal</h2>
          <p>Manage pickups, track deliveries & assign riders</p>
        </div>
        <div className="role-switch">
          <button className={`role-btn${riderView==="rider"?" active":""}`} onClick={() => setRiderView("rider")}>🚴 Rider View</button>
          <button className={`role-btn${riderView==="admin"?" active":""}`} onClick={() => setRiderView("admin")}>🛠️ Admin / Dispatch</button>
        </div>

        {tabLoading ? <ShimmerGrid/> : riderView === "rider" ? (
          <>
            <div style={{marginBottom:14}}>
              <label style={{fontSize:11,fontWeight:700,color:"var(--bark)",textTransform:"uppercase",letterSpacing:.5,display:"block",marginBottom:6}}>Logged in as</label>
              <select value={activeRider} onChange={e => setActiveRider(e.target.value)}
                style={{width:"100%",padding:"9px 12px",border:"1.5px solid var(--sand)",borderRadius:12,fontFamily:"var(--font-body)",fontSize:14,outline:"none",background:"white"}}>
                {riders.map(r => <option key={r.id} value={r.id}>{r.name} — {r.zone} {r.online?"🟢":"⚫"}</option>)}
              </select>
            </div>
            <div className="rider-profile">
              <div className="rider-avatar">🧑‍🦱</div>
              <div>
                <div className="rider-name">{myRider.name}</div>
                <div className="rider-meta">{myRider.vehicle} · {myRider.zone}</div>
                <div className="rider-meta">{myRider.phone}</div>
                <div className="rider-online"><div className="online-dot"/>{myRider.online?"Online · Ready for orders":"Offline — go online to accept orders"}</div>
              </div>
            </div>
            <div className="earnings-card">
              <div>
                <div className="earn-label">Today's Earnings</div>
                <div className="earn-val">{fmt(myRider.deliveries*1800,cur)}</div>
                <div className="earn-note">↑ 12% vs yesterday</div>
              </div>
              <div style={{textAlign:"right"}}>
                <div className="earn-label">Completed</div>
                <div style={{fontFamily:"var(--font-head)",fontSize:28,color:"var(--leaf)"}}>{myRider.deliveries}</div>
                <div style={{fontSize:10,color:"#aaa"}}>total deliveries</div>
              </div>
            </div>
            <div className="rider-stats">
              {[[myOrders.filter(o=>o.status==="available").length,"green","Available"],[myOrders.filter(o=>o.status==="assigned"&&o.riderId===activeRider).length,"gold","Assigned"],[myOrders.filter(o=>o.status==="picked-up"&&o.riderId===activeRider).length,"blue","In Transit"]].map(([v,c,l]) => (
                <div key={l} className="rider-stat"><div className={`rsv ${c}`}>{v}</div><div className="rsl">{l}</div></div>
              ))}
            </div>
            <div className="geo-card">
              <div className="geo-card-title">📍 Location Check-In</div>
              {riderLocation ? (
                <>
                  <div className="geo-status-ok">✅ Location confirmed</div>
                  <div className="geo-coords">Lat: {riderLocation.lat} · Lng: {riderLocation.lng}</div>
                  {(() => {
                    const hub = getCfg(country).hub.name;
                    const hc  = getCfg(country).hub.coords;
                    const dist = calcDistKm(parseFloat(riderLocation.lat), parseFloat(riderLocation.lng), hc.lat, hc.lng);
                    return <div style={{fontSize:12,color:"rgba(255,255,255,.7)",marginTop:6}}>🏭 {dist} km from {hub}</div>;
                  })()}
                </>
              ) : (
                <div style={{fontSize:12,color:"rgba(255,255,255,.65)",marginBottom:8}}>Check in to confirm your position and enable geo-fenced order acceptance.</div>
              )}
              <button className="geo-btn" style={{marginTop:8}} onClick={handleGeoCheckIn} disabled={geoLoading}>
                {geoLoading ? "📡 Acquiring GPS..." : riderLocation ? "🔄 Refresh Location" : "📍 Check In Now"}
              </button>
            </div>

            <div className="sec-label">📋 My Deliveries</div>
            {/* Optimised route card — shown when rider has checked in via GPS */}
            {riderLocation && (() => {
              const route = optimiseRoute(
                myOrders,
                parseFloat(riderLocation.lat),
                parseFloat(riderLocation.lng)
              );
              return route.sortedOrders.length > 0 ? (
                <RouteCard
                  route={route}
                  riderLat={parseFloat(riderLocation.lat)}
                  riderLng={parseFloat(riderLocation.lng)}
                />
              ) : null;
            })()}
            {myOrders.length === 0 && <div style={{textAlign:"center",padding:"30px",color:"#ccc"}}><div style={{fontSize:44}}>📭</div><p style={{marginTop:10,fontSize:13}}>No orders in your zone right now.</p></div>}
            {myOrders.map(o => {
              const st = STATUS_LABELS[o.status];
              const isMyOrder = o.riderId === activeRider;
              const isFree    = o.status  === "available";
              return (
                <div key={o.id} className={`delivery-card ${o.status}`}>
                  <div className="dc-top">
                    <div>
                      <div className="dc-id">{o.id} {o.priority==="high"&&<span style={{color:"var(--terra)",fontWeight:700}}>● URGENT</span>}</div>
                      <div style={{fontWeight:700,fontSize:15,marginTop:2}}>{o.customer}</div>
                    </div>
                    <div className={`dc-status ${st.cls}`}>{st.icon} {st.label}</div>
                  </div>
                  <div className="dc-products">{o.products.map((p,i)=><div key={i} className="dc-product-tag">{p.emoji} {p.name} · {p.qty}</div>)}</div>
                  <div className="dc-route"><span className="from">📦 {o.hub}</span><span className="arr">→</span><span className="to">📍 {o.address}</span></div>
                  <div className="dc-meta">
                    <div className="dc-meta-item">🗺️ <strong>{o.dist}</strong></div>
                    <div className="dc-meta-item">⏱️ <strong>{o.time}</strong></div>
                    <div className="dc-meta-item">💰 <strong>{fmt(o.total,cur)}</strong></div>
                    <div className="dc-meta-item">🕐 <strong>{o.placed}</strong></div>
                  </div>
                  <div className="dc-actions">
                    {isFree && (
                      <button className="dc-btn accept" disabled={!myRider.online} onClick={() => riderAccept(o.id)}
                        title={!myRider.online?"Go online to accept orders":""}>
                        {myRider.online?"✅ Accept Order":"🔴 Go Online to Accept"}
                      </button>
                    )}
                    {isMyOrder && o.status==="assigned"  && <><button className="dc-btn pickup"   onClick={() => riderPickup(o.id)}>📦 Mark Picked Up</button><button className="dc-btn cancel" onClick={() => adminUnassign(o.id)}>✕</button></>}
                    {isMyOrder && o.status==="picked-up" && <button className="dc-btn complete" onClick={() => riderComplete(o.id)}>🎉 Mark Delivered</button>}
                    {o.status==="delivered"              && <div className="dc-btn view-only">✅ Delivered — {fmt(o.total*0.12,cur)} earned</div>}
                  </div>
                </div>
              );
            })}
          </>
        ) : (
          <>
            <div className="rider-stats">
              {[[allOrders.filter(o=>o.status==="available").length,"green","Available"],[allOrders.filter(o=>o.status==="assigned").length,"gold","Assigned"],[allOrders.filter(o=>o.status==="picked-up").length,"blue","In Transit"],[allOrders.filter(o=>o.status==="delivered").length,"green","Done Today"]].map(([v,c,l]) => (
                <div key={l} className="rider-stat"><div className={`rsv ${c}`}>{v}</div><div className="rsl">{l}</div></div>
              ))}
            </div>
            <div style={{background:"white",borderRadius:14,padding:14,boxShadow:"var(--shadow-sm)",marginBottom:16}}>
              <div style={{fontWeight:700,fontSize:12,color:"var(--forest)",marginBottom:10,textTransform:"uppercase",letterSpacing:.5}}>🚴 Riders Online</div>
              {riders.filter(r=>r.online).map(r=>(
                <div key={r.id} style={{display:"flex",alignItems:"center",gap:10,padding:"7px 0",borderBottom:"1px solid var(--sand)"}}>
                  <div style={{width:34,height:34,borderRadius:"50%",background:"linear-gradient(135deg,var(--leaf),var(--mint))",display:"flex",alignItems:"center",justifyContent:"center",fontSize:16,flexShrink:0}}>🧑‍🦱</div>
                  <div style={{flex:1}}>
                    <div style={{fontWeight:600,fontSize:13}}>{r.name}</div>
                    <div style={{fontSize:11,color:"#aaa"}}>{r.vehicle} · {r.zone}</div>
                  </div>
                  <div style={{textAlign:"right"}}>
                    <div style={{fontSize:11,fontWeight:700,color:"var(--leaf)"}}>★ {r.rating}</div>
                    <div style={{fontSize:10,color:"#aaa"}}>{allOrders.filter(o=>o.riderId===r.id&&o.status!=="delivered").length} active</div>
                  </div>
                </div>
              ))}
            </div>
            <div className="sec-label">📋 All Orders — {country==="TZ"?"Dar es Salaam":"Nairobi"}</div>
            {allOrders.map(o => {
              const st = STATUS_LABELS[o.status];
              const assignedRider = riders.find(r => r.id===o.riderId);
              return (
                <div key={o.id} className={`delivery-card ${o.status}`}>
                  <div className="dc-top">
                    <div>
                      <div className="dc-id">{o.id} {o.priority==="high"&&<span style={{color:"var(--terra)",fontWeight:700}}>● URGENT</span>}</div>
                      <div style={{fontWeight:700,fontSize:15,marginTop:2}}>{o.customer}</div>
                    </div>
                    <div className={`dc-status ${st.cls}`}>{st.icon} {st.label}</div>
                  </div>
                  <div className="dc-products">{o.products.map((p,i)=><div key={i} className="dc-product-tag">{p.emoji} {p.name} · {p.qty}</div>)}</div>
                  <div className="dc-route"><span className="from">📦 {o.hub}</span><span className="arr">→</span><span className="to">📍 {o.address}</span></div>
                  <div className="dc-meta">
                    <div className="dc-meta-item">🗺️ <strong>{o.dist}</strong></div>
                    <div className="dc-meta-item">⏱️ <strong>{o.time}</strong></div>
                    <div className="dc-meta-item">💰 <strong>{fmt(o.total,cur)}</strong></div>
                    {assignedRider && <div className="dc-meta-item">🚴 <strong>{assignedRider.name}</strong></div>}
                  </div>
                  {(o.status==="available"||o.status==="assigned") && <AdminAssign order={o} riders={riders} onAssign={rid=>adminAssign(o.id,rid)} onUnassign={()=>adminUnassign(o.id)}/>}
                  {o.status==="picked-up"  && <div style={{marginTop:10,fontSize:12,color:"#4285F4",fontWeight:600}}>🔵 In transit with {assignedRider?.name}</div>}
                  {o.status==="delivered"  && <div style={{marginTop:10,fontSize:12,color:"var(--leaf)",fontWeight:600}}>✅ Delivered by {assignedRider?.name} · {fmt(o.total*0.88,cur)} to farmer</div>}
                </div>
              );
            })}
          </>
        )}
      </div>
    )}

    {/* ══════════ AGRIPASS ══════════ */}
    {tab === "agripass" && (
      <AgriPass
        showToast={showToast}
        submissions={apSubmissions}
        setSubmissions={setApSubmissions}
        country={country}
      />
    )}

    {/* ══════════ HERDPASS ══════════ */}
    {tab === "herd" && (
      <HerdTab
        userRole={userRole}
        country={country}
        showToast={showToast}
        cur={cur}
      />
    )}

    {/* ══════════ ANALYTICS + UNIT TESTS ══════════ */}
    {tab === "analytics" && (
      <div>
        <AnalyticsDashboard cur={cur} country={country}/>
        {userRole === "admin" && (
          <div style={{borderTop:"2px dashed var(--sand)",marginTop:4}}>
            <div style={{padding:"10px 16px 0",fontSize:11,fontWeight:700,color:"#aaa",textTransform:"uppercase",letterSpacing:.8}}>🧪 QA — Unit Test Suite</div>
            <UnitTestSuite/>
          </div>
        )}
      </div>
    )}

    {/* ══════════ PRODUCT MODAL ══════════ */}
    {selected && (
      <div className="modal-bd" role="dialog" aria-modal="true"
           aria-label={`${selected.name} — product details`}
           onClick={() => setSelected(null)}>
        <div className="modal" ref={modalRef} onClick={e => e.stopPropagation()}>
          <div className="modal-handle"/>
          {selected.videoUrl ? (
            <div className="modal-video-wrap">
              <video className="modal-video" src={selected.videoUrl}
                     autoPlay muted loop playsInline preload="metadata"
                     aria-label={`Harvest preview for ${selected.name}`}/>
              <div className="modal-video-badge">▶ Farmer Preview</div>
              <button className="modal-close" aria-label="Close product details" onClick={() => setSelected(null)}>✕</button>
            </div>
          ) : (
            <div className="modal-img">
              <span style={{fontSize:84}}>{selected.emoji}</span>
              <div className="modal-badges">
                {selected.organic  && <span className="badge-org">Organic</span>}
                {selected.verified && <span className="badge-ver">★ Verified</span>}
              </div>
              <button className="modal-close" aria-label="Close product details" onClick={() => setSelected(null)}>✕</button>
            </div>
          )}
          <div className="modal-body">
            <div className="modal-title">{selected.name}</div>
            <div className="modal-main-price">{fmt(selected.tzsPrice,cur)}</div>
            <div className="modal-unit">per {selected.unit} · harvested {selected.harvest} · {calcETA(selected.dist)}</div>
            <PriceCompare product={selected} cur={cur} country={country}/>
            <div className="conv-grid">
              {CURRENCIES.map(c => (
                <div key={c.code} className={`conv-pill${cur===c.code?" active-cur":""}${c.code==="TZS"?" base-cur":""}`} onClick={() => setCur(c.code)}>
                  <span className="cf">{c.flag}</span>
                  <span className="cv">{fmt(selected.tzsPrice,c.code)}</span>
                  <span className="cc">{c.code}{c.code==="TZS"?" ★":""}</span>
                </div>
              ))}
            </div>
            <div className="modal-weighted">⚖️ <strong>Variable Weight Pricing:</strong> A {fmt(selected.tzsPrice*0.1,cur)} buffer pre-authorised, reconciled via {country==="TZ"?"Tigo Pesa/Vodacom":"M-Pesa"} on delivery. Settled in TZS.</div>
            <div className="divider"/>
            <div style={{fontWeight:700,fontSize:10,textTransform:"uppercase",letterSpacing:1,color:"#bbb",marginBottom:9}}>🌾 Meet the Farmer</div>
            <div className="farmer-card">
              <div className="farmer-av">👨‍🌾</div>
              <div style={{flex:1}}>
                <div className="farmer-name">{selected.farmer}</div>
                <div className="farmer-loc">📍 {selected.farm} · {selected.dist} away</div>
                <div className="farmer-bio">{selected.bio}</div>
                <div className="farmer-stats">
                  {[[selected.rating,"Rating"],[selected.sales+"+","Orders"],[selected.dist,"Dist."]].map(([v,l])=>(
                    <div key={l}><div className="fs-val">{v}</div><div className="fs-lbl">{l}</div></div>
                  ))}
                </div>
              </div>
            </div>
            <div className="qr-row">
              <div className="qr-box">▣</div>
              <div className="qr-text"><strong>Full Traceability</strong><br/>Scan bag QR to verify farm origin.<br/>Code: <strong>{selected.traceability}</strong></div>
            </div>

            {/* ── WhatsApp contact ── */}
            {selected.farmerPhone && (() => {
              const msg = encodeURIComponent(`Habari ${selected.farmer}! Ninaomba ${selected.name} kutoka ${selected.farm}. Je, una bei ya jumla?`);
              return (
                <div style={{marginTop:14,display:"flex",alignItems:"center",gap:10}}>
                  <a
                    href={`https://wa.me/${selected.farmerPhone.replace(/\D/g,"")}?text=${msg}`}
                    className="wa-btn"
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`Chat with ${selected.farmer} on WhatsApp`}
                    style={{flex:1,justifyContent:"center",fontSize:13,padding:"10px"}}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.570-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.890-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413Z"/></svg>
                    Chat with Farmer on WhatsApp
                  </a>
                </div>
              );
            })()}

            {/* ── Wholesale pricing tiers ── */}
            {selected.wholesale?.length > 0 && (
              <div className="wholesale-section">
                <div className="divider"/>
                <div className="wholesale-label">📦 Bulk / Wholesale Pricing</div>
                <table className="wholesale-table" aria-label="Wholesale pricing tiers">
                  <thead>
                    <tr>
                      <th>Min Qty</th>
                      <th>Price / {selected.unit}</th>
                      <th>Saving</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>1+ {selected.unit}</td>
                      <td>{fmt(selected.tzsPrice, cur)}</td>
                      <td style={{color:"#aaa"}}>—</td>
                    </tr>
                    {selected.wholesale.map((tier, i) => {
                      const savePct = Math.round((1 - tier.price / selected.tzsPrice) * 100);
                      return (
                        <tr key={i}>
                          <td>{tier.minQty}+ {selected.unit}</td>
                          <td><strong>{fmt(tier.price, cur)}</strong></td>
                          <td className="wt-save">−{savePct}%</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {/* ── Customer Reviews ── */}
            {(() => {
              const productReviews = reviews.filter(r => r.product === selected.name || r.farmerName === selected.farmer);
              const avgRating = productReviews.length
                ? (productReviews.reduce((s,r) => s + r.rating, 0) / productReviews.length).toFixed(1)
                : null;
              return (
                <div style={{marginTop:14}}>
                  <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
                    <div style={{fontWeight:700,fontSize:11,textTransform:"uppercase",letterSpacing:.8,color:"#bbb"}}>
                      ⭐ Customer Reviews
                    </div>
                    {avgRating && (
                      <div style={{fontWeight:700,fontSize:13,color:"var(--gold)"}}>
                        {avgRating} ★ <span style={{fontWeight:400,fontSize:11,color:"#aaa"}}>({productReviews.length})</span>
                      </div>
                    )}
                  </div>
                  {productReviews.length === 0 ? (
                    <div style={{fontSize:12,color:"#aaa",fontStyle:"italic",padding:"8px 0"}}>
                      No reviews yet — be the first to review after delivery!
                    </div>
                  ) : (
                    productReviews.slice(0,3).map(r => (
                      <div key={r.id} className="review-item">
                        <div className="review-item-header">
                          <span className="review-stars-display">{"⭐".repeat(r.rating)}</span>
                          <span className="review-customer">{r.customer}</span>
                        </div>
                        {r.comment && <div className="review-text">{r.comment}</div>}
                        <div className="review-date">{r.createdAt}</div>
                      </div>
                    ))
                  )}
                  {/* Demo trigger — visible only in demo mode */}
                  {!API_BASE && (
                    <button
                      style={{width:"100%",marginTop:8,background:"none",border:"1.5px dashed var(--sand)",
                              borderRadius:10,padding:"7px",fontSize:11,color:"#aaa",cursor:"pointer",
                              fontFamily:"var(--font-body)"}}
                      onClick={() => setReviewPrompt({
                        id:"ORD-DEMO",
                        products:[{name:selected.name, qty:"1 "+selected.unit}],
                        customer:"Demo User",
                        country,
                      })}>
                      🧪 Demo — Trigger Review Modal
                    </button>
                  )}
                </div>
              );
            })()}
          </div>
          <div style={{padding:"0 20px 6px"}}>
            <StockBadge qty={stockMap[selected.id] ?? selected.stockQty ?? 999}/>
          </div>
          {(stockMap[selected.id] ?? selected.stockQty ?? 999) <= 0 && !inCart(selected.id) ? (
            <button
              className={`notify-btn${stockAlerts.has(selected.id) ? " active" : ""}`}
              style={{margin:"12px 20px 0",width:"calc(100% - 40px)"}}
              onClick={() => { toggleStockAlert(selected.id); showToast(stockAlerts.has(selected.id) ? "Alert removed" : "🔔 We'll notify you when it's back!"); }}>
              {stockAlerts.has(selected.id) ? "🔔 Alert set — we'll notify you!" : "🔕 Notify me when back in stock"}
            </button>
          ) : (
            <button className="modal-add"
              disabled={(stockMap[selected.id] ?? selected.stockQty ?? 999) <= 0 && !inCart(selected.id)}
              onClick={() => addToCart(selected)}>
              {inCart(selected.id)
                ? "✓ Already in Cart"
                : `🛒 Add to Cart — ${fmt(selected.tzsPrice,cur)} /${selected.unit}`}
            </button>
          )}
          {/* Receipt share */}
          {inCart(selected.id) && (
            <button className="receipt-share-btn" style={{margin:"8px 20px 0",width:"calc(100% - 40px)"}}
              onClick={() => {
                const msg = buildReceiptText(cart, cur, country);
                window.open(`https://wa.me/?text=${encodeURIComponent(msg)}`, "_blank", "noopener");
              }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.570-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.890-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413Z"/></svg>
              Share Receipt via WhatsApp
            </button>
          )}
        </div>
      </div>
    )}

    {/* ══════════ CART PANEL ══════════ */}
    {cartOpen && (
      <div className="cart-panel" role="dialog" aria-modal="true" aria-label="Shopping cart">
        <div className="cart-head">
          <h3>{t("cart.title")} {curMeta.flag}</h3>
          <button className="cart-close" aria-label="Close cart" onClick={() => setCartOpen(false)}>✕</button>
        </div>
        <div className="cart-items">
          {cart.length === 0 ? (
            <div className="cart-empty"><div className="ce">🛒</div><p>Your cart is empty.<br/>Browse fresh listings!</p></div>
          ) : cart.map(p => (
            <div key={p.id} className="cart-item">
              <div className="ci-emoji">{p.emoji}</div>
              <div style={{flex:1}}>
                <div className="ci-name">{p.name}</div>
                <div className="ci-farmer">{p.farmer} · {p.dist}</div>
                <div className="ci-price">{fmt(p.tzsPrice*getQty(p.id),cur)} /{p.unit}</div>
                {cur!=="TZS" && <div className="ci-tzs">≈ TZS {(p.tzsPrice*getQty(p.id)).toLocaleString()}</div>}
                <div className="ci-qty-row">
                  <button className="qty-btn" onClick={() => changeQty(p.id,-1)}>−</button>
                  <span className="qty-val">{getQty(p.id)}</span>
                  <button className="qty-btn" onClick={() => changeQty(p.id,+1)}>+</button>
                  <button className="ci-remove" onClick={() => removeFromCart(p.id)} title="Remove">🗑</button>
                </div>
              </div>
            </div>
          ))}
          {undoItem && (
            <div className="undo-bar">
              <span>"{undoItem.item.name}" removed</span>
              <button className="undo-btn" onClick={undoRemove}>Undo</button>
            </div>
          )}
        </div>
        {cart.length > 0 && (
          <div className="cart-foot">
            {(() => {
              const tier     = getLoyaltyTier(loyaltyPts);
              const nextTier = LOYALTY_TIERS[LOYALTY_TIERS.indexOf(tier)+1];
              const range    = nextTier ? nextTier.min - tier.min : 1;
              const pct      = nextTier ? Math.min(100, ((loyaltyPts - tier.min) / range) * 100) : 100;
              const redeemTZS = redeemValue(loyaltyPts);
              const canRedeem = loyaltyPts >= 100;
              return (
                <div>
                  <div className="loyalty-bar">
                    <span className="loyalty-icon">{tier.icon}</span>
                    <div style={{flex:1}}>
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline"}}>
                        <span className="loyalty-pts">{loyaltyPts.toLocaleString()} pts</span>
                        <span style={{fontSize:11,opacity:.8}}>{tier.name}</span>
                      </div>
                      <div className="loyalty-tier">{nextTier?`${nextTier.min-loyaltyPts} pts to ${nextTier.name}`:"Top tier — Gold Farmer 🏆"}</div>
                      <div className="loyalty-progress"><div className="loyalty-fill" style={{width:`${pct}%`}}/></div>
                    </div>
                  </div>
                  {canRedeem && (
                    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",background:"rgba(233,163,25,.12)",border:"1.5px solid rgba(233,163,25,.35)",borderRadius:10,padding:"8px 12px",marginTop:6}}>
                      <div>
                        <div style={{fontSize:12,fontWeight:700,color:"#856404"}}>⭐ Redeem Points</div>
                        <div style={{fontSize:11,color:"#aaa",marginTop:1}}>{loyaltyPts} pts = {fmt(redeemTZS,"TZS")} off</div>
                      </div>
                      <button
                        onClick={() => {
                          const disc = Math.min(redeemTZS, cartTZS);
                          setCouponResult({ valid:true, discount:disc, desc:`${loyaltyPts} loyalty points redeemed`, code:"LOYALTY" });
                          setLoyaltyPts(0);
                          showToast(`⭐ ${loyaltyPts} pts redeemed — ${fmt(disc,"TZS")} off!`);
                        }}
                        style={{background:"#e9a319",color:"white",border:"none",borderRadius:8,padding:"6px 12px",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"var(--font-body)",whiteSpace:"nowrap"}}>
                        Redeem
                      </button>
                    </div>
                  )}
                </div>
              );
            })()}

            <div style={{marginBottom:10}}>
              <div style={{fontSize:11,fontWeight:700,color:"var(--bark)",marginBottom:5}}>🎟️ Coupon Code</div>
              <div className="coupon-row">
                <input className="coupon-input" placeholder="e.g. FRESH10, FIRSTBUY..."
                  value={couponCode} onChange={e=>{setCouponCode(e.target.value); setCouponResult(null);}}
                  onKeyDown={e=>e.key==="Enter"&&handleApplyCoupon()}/>
                <button className="coupon-btn" onClick={handleApplyCoupon}>Apply</button>
              </div>
              {couponResult?.valid  && <div className="coupon-ok">✅ {couponResult.desc} — saving {fmt(couponResult.discount,"TZS")}</div>}
              {couponResult && !couponResult.valid && <div className="coupon-err">❌ {couponResult.error}</div>}
            </div>

            <div style={{marginBottom:12}}>
              <AddressBook
                country={country}
                selectedId={selectedAddressId}
                onSelect={a => setSelectedAddressId(a.id)}
              />
            </div>
            <div className="cart-sub"><span>Subtotal (est.)</span><span>{fmt(cartTZS,cur)}</span></div>
            {couponResult?.valid && (
              <div className="discount-line"><span>🎟️ {couponResult.code}</span><span>−{fmt(couponResult.discount,cur)}</span></div>
            )}
            <div className="cart-sub"><span>Hub & Delivery</span><span>{fmt(DELIV_TZS,cur)}</span></div>
            {(() => {
              const disc     = couponResult?.valid ? couponResult.discount : 0;
              const finalTZS = Math.max(0, cartTZS - disc) + DELIV_TZS;
              return (
                <>
                  <div className="cart-tot"><span>Total</span><span>{fmt(finalTZS,cur)}</span></div>
                  {cur!=="TZS" && <div style={{fontSize:10,color:"#bbb",marginTop:2}}>≈ TZS {finalTZS.toLocaleString()} · Base currency</div>}
                  <div className="cart-note">⚖️ Weighted estimate — all charges settled in TZS</div>
                  <button className="chk-btn-main" onClick={() => {
                    analytics.capture("checkout.started", { totalTZS: finalTZS, items: cart.length, country });
                    setPayOpen(true);
                  }}>🔒 Checkout · {fmt(finalTZS,cur)}</button>
                  <button className="chama-btn" onClick={() => { setCartOpen(false); setChamaOpen(true); }}>
                    🤝 Start Chama Group Order
                  </button>
                  <div style={{display:"flex",gap:8,marginTop:8}}>
                    <button style={{flex:1,background:"#000",color:"white",border:"none",borderRadius:10,padding:"10px 6px",fontSize:12,fontWeight:700,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:4}} onClick={() => setPayOpen(true)}>🍎 Pay · {fmt(finalTZS,cur)}</button>
                    <button style={{flex:1,background:"white",color:"#3c4043",border:"1.5px solid #dadce0",borderRadius:10,padding:"10px 6px",fontSize:11,fontWeight:700,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:2}} onClick={() => setPayOpen(true)}>
                      <span style={{color:"#4285F4"}}>G</span><span style={{color:"#EA4335"}}>o</span><span style={{color:"#FBBC05"}}>o</span><span style={{color:"#34A853"}}>g</span><span style={{color:"#4285F4"}}>le</span><span style={{color:"#5f6368",fontSize:10}}> Pay · {fmt(finalTZS,cur)}</span>
                    </button>
                  </div>
                </>
              );
            })()}
            <div style={{fontSize:10,color:"#aaa",marginTop:8,textAlign:"center"}}>
              {getCfg(country).commission.label}
            </div>
          </div>
        )}
      </div>
    )}

    {/* PAYMENT GATEWAY */}
    {payOpen && (() => {
      const disc     = couponResult?.valid ? couponResult.discount : 0;
      const finalTZS = Math.max(0, cartTZS - disc) + DELIV_TZS;
      return (
        <PaymentGatewayWithStripe
          totalTZS={finalTZS}
          cur={cur}
          country={country}
          cart={cart}
          qty={qty}
          couponResult={couponResult}
          loyaltyPts={loyaltyPts}
          onClose={() => setPayOpen(false)}
          onSuccess={() => {
            awardLoyaltyPts(finalTZS);
            analytics.capture("checkout.completed", { totalTZS: finalTZS, country, items: cart.length });
            setCart([]); setQty({}); setCartOpen(false);
            setCouponCode(""); setCouponResult(null);
            showToast(t("toast.order_placed"));
          }}
        />
      );
    })()}

    {/* REVIEW MODAL — shown after delivery */}
    {reviewPrompt && (
      <ReviewModal
        order={reviewPrompt}
        cur={cur}
        country={country}
        onClose={() => setReviewPrompt(null)}
        onSubmit={review => {
          setReviews(prev => [review, ...prev]);
          showToast(t("toast.review_thanks"));
        }}
      />
    )}

    {/* CHAMA GROUP ORDER SHEET */}
    {chamaOpen && (
      <ChamaSheet
        cart={cart} cur={cur} country={country}
        onClose={() => setChamaOpen(false)}
        onCheckout={() => { setChamaOpen(false); setPayOpen(true); }}
        showToast={showToast}
      />
    )}

    {/* FARMER TOUR — shown once after first approval */}
    {userRole === "farmer" && farmerOnboarded && !farmerTourSeen && (
      <FarmerTour onDone={dismissFarmerTour}/>
    )}

    {/* LIVE TRACKING MAP */}
    {mapOrder && (() => {
      const rider = riders.find(r => r.id === mapOrder.riderId);
      return (
        <LiveTrackingMap
          order={mapOrder}
          riderData={rider ? { name: rider.name, vehicle: rider.vehicle, phone: rider.phone } : null}
          onClose={() => setMapOrder(null)}
        />
      );
    })()}

    {/* TOAST — aria-live so screen readers announce status changes */}
    <div role="status" aria-live="polite" aria-atomic="true"
         style={{position:"absolute",left:"-9999px",width:"1px",height:"1px",overflow:"hidden"}}>
      {toast}
    </div>
    {toast && <div className="toast" role="alert">{toast}</div>}

    {/* SCROLL TO TOP */}
    {showScroll && (
      <button className="scroll-top" onClick={scrollTop}
              aria-label="Scroll back to top">↑</button>
    )}

    {/* BOTTOM NAV — role-filtered + cart badge */}
    <nav className="bottom-nav" aria-label="Tab navigation">
      {NAV_TABS
        .filter(n => !userRole || ROLES[userRole]?.tabs.includes(n.id))
        .map(n => (
        <button key={n.id} className={`bn-item${tab===n.id?" active":""}`}
          aria-label={n.id === "market" && cartLineCount > 0
            ? `${n.label}, ${cartLineCount} item${cartLineCount > 1 ? "s" : ""} in cart`
            : n.label}
          aria-current={tab === n.id ? "page" : undefined}
          onClick={() => switchTab(n.id)}>
          <span className="bn-icon">{n.icon}</span>
          <span className="bn-label">{n.label}</span>
          {n.id==="market" && cartLineCount>0 && <span className="bn-badge">{cartLineCount}</span>}
        </button>
      ))}
    </nav>

  </div>
</>

);
}

// ─── Root export — ErrorBoundary + TranslationProvider wrap the entire tree ──────────
// index.html should include:
//   <noscript>
//     <div style="padding:20px;font-family:sans-serif;text-align:center">
//       Asiel Farm Shop requires JavaScript. Please enable it in your browser.
//     </div>
//   </noscript>
//   <html lang="sw">
//   <meta charset="UTF-8">
//   <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
//   <meta name="description" content="Asiel Farm Shop — Farm-to-Fork marketplace Tanzania & Kenya">
//   <link rel="manifest" href="/manifest.json">
//   <link rel="apple-touch-icon" href="/icons/icon-192.png">
// Module-level reset hook — AppInner calls _resetEB() on logout to
// remount the ErrorBoundary and clear any stale error state.
let _resetEB = () => {};

export default function App() {
const [ebKey, setEbKey] = React.useState(0);
_resetEB = () => setEbKey(k => k + 1);
return (
<ErrorBoundary key={ebKey}>
<TranslationProvider>
<AppInner />
</TranslationProvider>
</ErrorBoundary>
);
}