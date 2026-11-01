/** Money is always whole paise (integers). Never floating point. */
export type Paise = number;

export const rupees = (r: number): Paise => Math.round(r * 100);

/** Percentage of an amount, rounded half up to the paisa. */
export const percentOf = (amount: Paise, percent: number): Paise => Math.round((amount * percent) / 100);

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2 });
export const formatInr = (p: Paise) => inr.format(p / 100);
