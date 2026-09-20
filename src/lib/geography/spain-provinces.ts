/**
 * Canonical Spain geography dataset (Prompt 1 §1.4). Backs
 * `SpainEligibilityService` and will back the Phase 2 geography planner
 * instead of a hardcoded small city list.
 */

export interface SpainProvince {
  name: string;
  autonomousCommunity: string;
  /** Two-digit prefix used by the first two digits of Spanish postal codes. */
  postalPrefix: string;
}

/** All 50 provinces plus the two autonomous cities (Ceuta, Melilla), which share the postal-code scheme. */
export const SPAIN_PROVINCES: readonly SpainProvince[] = [
  { name: "Álava", autonomousCommunity: "País Vasco", postalPrefix: "01" },
  { name: "Albacete", autonomousCommunity: "Castilla-La Mancha", postalPrefix: "02" },
  { name: "Alicante", autonomousCommunity: "Comunidad Valenciana", postalPrefix: "03" },
  { name: "Almería", autonomousCommunity: "Andalucía", postalPrefix: "04" },
  { name: "Ávila", autonomousCommunity: "Castilla y León", postalPrefix: "05" },
  { name: "Badajoz", autonomousCommunity: "Extremadura", postalPrefix: "06" },
  { name: "Illes Balears", autonomousCommunity: "Illes Balears", postalPrefix: "07" },
  { name: "Barcelona", autonomousCommunity: "Cataluña", postalPrefix: "08" },
  { name: "Burgos", autonomousCommunity: "Castilla y León", postalPrefix: "09" },
  { name: "Cáceres", autonomousCommunity: "Extremadura", postalPrefix: "10" },
  { name: "Cádiz", autonomousCommunity: "Andalucía", postalPrefix: "11" },
  { name: "Castellón", autonomousCommunity: "Comunidad Valenciana", postalPrefix: "12" },
  { name: "Ciudad Real", autonomousCommunity: "Castilla-La Mancha", postalPrefix: "13" },
  { name: "Córdoba", autonomousCommunity: "Andalucía", postalPrefix: "14" },
  { name: "A Coruña", autonomousCommunity: "Galicia", postalPrefix: "15" },
  { name: "Cuenca", autonomousCommunity: "Castilla-La Mancha", postalPrefix: "16" },
  { name: "Girona", autonomousCommunity: "Cataluña", postalPrefix: "17" },
  { name: "Granada", autonomousCommunity: "Andalucía", postalPrefix: "18" },
  { name: "Guadalajara", autonomousCommunity: "Castilla-La Mancha", postalPrefix: "19" },
  { name: "Gipuzkoa", autonomousCommunity: "País Vasco", postalPrefix: "20" },
  { name: "Huelva", autonomousCommunity: "Andalucía", postalPrefix: "21" },
  { name: "Huesca", autonomousCommunity: "Aragón", postalPrefix: "22" },
  { name: "Jaén", autonomousCommunity: "Andalucía", postalPrefix: "23" },
  { name: "León", autonomousCommunity: "Castilla y León", postalPrefix: "24" },
  { name: "Lleida", autonomousCommunity: "Cataluña", postalPrefix: "25" },
  { name: "La Rioja", autonomousCommunity: "La Rioja", postalPrefix: "26" },
  { name: "Lugo", autonomousCommunity: "Galicia", postalPrefix: "27" },
  { name: "Madrid", autonomousCommunity: "Comunidad de Madrid", postalPrefix: "28" },
  { name: "Málaga", autonomousCommunity: "Andalucía", postalPrefix: "29" },
  { name: "Murcia", autonomousCommunity: "Región de Murcia", postalPrefix: "30" },
  { name: "Navarra", autonomousCommunity: "Comunidad Foral de Navarra", postalPrefix: "31" },
  { name: "Ourense", autonomousCommunity: "Galicia", postalPrefix: "32" },
  { name: "Asturias", autonomousCommunity: "Principado de Asturias", postalPrefix: "33" },
  { name: "Palencia", autonomousCommunity: "Castilla y León", postalPrefix: "34" },
  { name: "Las Palmas", autonomousCommunity: "Canarias", postalPrefix: "35" },
  { name: "Pontevedra", autonomousCommunity: "Galicia", postalPrefix: "36" },
  { name: "Salamanca", autonomousCommunity: "Castilla y León", postalPrefix: "37" },
  { name: "Santa Cruz de Tenerife", autonomousCommunity: "Canarias", postalPrefix: "38" },
  { name: "Cantabria", autonomousCommunity: "Cantabria", postalPrefix: "39" },
  { name: "Segovia", autonomousCommunity: "Castilla y León", postalPrefix: "40" },
  { name: "Sevilla", autonomousCommunity: "Andalucía", postalPrefix: "41" },
  { name: "Soria", autonomousCommunity: "Castilla y León", postalPrefix: "42" },
  { name: "Tarragona", autonomousCommunity: "Cataluña", postalPrefix: "43" },
  { name: "Teruel", autonomousCommunity: "Aragón", postalPrefix: "44" },
  { name: "Toledo", autonomousCommunity: "Castilla-La Mancha", postalPrefix: "45" },
  { name: "Valencia", autonomousCommunity: "Comunidad Valenciana", postalPrefix: "46" },
  { name: "Valladolid", autonomousCommunity: "Castilla y León", postalPrefix: "47" },
  { name: "Bizkaia", autonomousCommunity: "País Vasco", postalPrefix: "48" },
  { name: "Zamora", autonomousCommunity: "Castilla y León", postalPrefix: "49" },
  { name: "Zaragoza", autonomousCommunity: "Aragón", postalPrefix: "50" },
  { name: "Ceuta", autonomousCommunity: "Ceuta", postalPrefix: "51" },
  { name: "Melilla", autonomousCommunity: "Melilla", postalPrefix: "52" },
] as const;

const PROVINCE_BY_PREFIX = new Map(SPAIN_PROVINCES.map((province) => [province.postalPrefix, province]));
const PROVINCE_NAMES = new Set(SPAIN_PROVINCES.map((province) => province.name.toLowerCase()));

/** Returns the province for a valid 5-digit Spanish postal code, or `null`. */
export function provinceForPostalCode(postalCode: string | null | undefined): SpainProvince | null {
  if (!postalCode) return null;
  const trimmed = postalCode.trim();
  if (!/^\d{5}$/.test(trimmed)) return null;
  return PROVINCE_BY_PREFIX.get(trimmed.slice(0, 2)) ?? null;
}

export function isKnownSpainProvinceName(name: string | null | undefined): boolean {
  if (!name) return false;
  return PROVINCE_NAMES.has(name.trim().toLowerCase());
}

/**
 * Rough bounding box covering continental Spain, the Balearic Islands and
 * the Canary Islands — deliberately generous; only used as one supporting
 * geo signal, never as sole proof of Spain eligibility.
 */
export function isWithinSpainBoundingBox(latitude: number, longitude: number): boolean {
  const continentalAndBalearic = latitude >= 35.9 && latitude <= 43.9 && longitude >= -9.5 && longitude <= 4.4;
  const canaryIslands = latitude >= 27.6 && latitude <= 29.5 && longitude >= -18.3 && longitude <= -13.3;
  return continentalAndBalearic || canaryIslands;
}
