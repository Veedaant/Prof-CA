/** Banks offered in the Banking section's drop-down. Anything else is entered by hand under "Other". */
export const OTHER_BANK = "Other";

export const BANKS = [
  "State Bank of India", "HDFC Bank", "ICICI Bank", "Axis Bank", "Kotak Mahindra Bank",
  "Punjab National Bank", "Bank of Baroda", "Canara Bank", "Union Bank of India", "Bank of India",
  "Indian Bank", "Central Bank of India", "Indian Overseas Bank", "UCO Bank", "Bank of Maharashtra",
  "Punjab & Sind Bank", "IDBI Bank", "Yes Bank", "IndusInd Bank", "IDFC FIRST Bank",
  "Federal Bank", "South Indian Bank", "Karnataka Bank", "Karur Vysya Bank", "City Union Bank",
  "RBL Bank", "Bandhan Bank", "DCB Bank", "Jammu & Kashmir Bank", "Tamilnad Mercantile Bank",
  "AU Small Finance Bank", "Equitas Small Finance Bank", "Ujjivan Small Finance Bank",
  "Saraswat Co-operative Bank", "Standard Chartered Bank", "HSBC", "Citibank", "Deutsche Bank",
];

export const bankOptions = () => [...BANKS, OTHER_BANK];
