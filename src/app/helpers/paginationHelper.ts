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
  const page: number = Math.max(Number(options.page) || 1, 1);
  const limit: number = Math.min(
    Math.max(Number(options.limit) || 10, 1),
    maxLimit,
  );
  const skip: number = (Number(page) - 1) * limit;

  const sortBy: string = options.sortBy || "created_at";
  const sortOrder: string = options.sortOrder || "desc";

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
