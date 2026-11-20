// "Facade cleaning!" -> "facade_cleaning". Used for the stable keys of configurable
// lists (service types, inquiry statuses). Returns "" if nothing usable is left.
const toKey = (label: string): string =>
  label
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 50);

export default toKey;
