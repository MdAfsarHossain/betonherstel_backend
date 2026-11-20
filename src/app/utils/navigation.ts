// Opens an address in the phone's maps app (planning and work orders, FR-PLAN-06)
export const navigationUrl = (a: {
  street?: string | null;
  house_number?: string | null;
  postcode?: string | null;
  city?: string | null;
  country?: string | null;
}) => {
  if (!a.street || !a.city) return null;
  const destination = `${a.street} ${a.house_number ?? ""}, ${a.postcode ?? ""} ${a.city}, ${a.country ?? "NL"}`
    .replace(/\s+/g, " ")
    .trim();
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination)}`;
};
