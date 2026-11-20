// "1234ab" / "1234 ab" -> "1234 AB"; anything else (foreign postcodes) is only upper-cased
const normalizePostcode = (postcode: string) => {
  const match = postcode.trim().match(/^([1-9][0-9]{3})\s?([A-Za-z]{2})$/);
  return match
    ? `${match[1]} ${match[2].toUpperCase()}`
    : postcode.trim().toUpperCase();
};

export default normalizePostcode;
