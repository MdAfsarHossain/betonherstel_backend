type IOptions = {
  page?: number;
  limit?: number;
  sortOrder?: string;
  sortBy?: string;
};

type IOptionsResult = {
  page: number;
  limit: number;
  skip: number;
  sortBy: string;
  sortOrder: string;
};

const maxLimit = 100;

const calculatePagination = (options: IOptions): IOptionsResult => {
  options = options ?? {};
  const page: number = Math.max(Number(options.page) || 1, 1);
  const limit: number = Math.min(
    Math.max(Number(options.limit) || 10, 1),
    maxLimit,
  );
  const skip: number = (Number(page) - 1) * limit;

  // Query values can be arrays (?sortOrder=a&sortOrder=b) or names of Object.prototype members that
  // the modules' column whitelists would wrongly find ("constructor", "__proto__", "toString"):
  // only a plain column-style name is passed on, and the order is only ever "asc" or "desc"
  const first = (v: unknown) => (Array.isArray(v) ? v[0] : v);
  const rawSortBy = first(options.sortBy);
  const sortBy: string =
    typeof rawSortBy === "string" &&
    /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(rawSortBy) &&
    !(rawSortBy in Object.prototype)
      ? rawSortBy
      : "created_at";
  const sortOrder: string =
    String(first(options.sortOrder) ?? "").toLowerCase() === "asc" ? "asc" : "desc";

  return {
    page,
    limit,
    skip,
    sortBy,
    sortOrder,
  };
};

export const paginationHelper = {
  calculatePagination,
};
