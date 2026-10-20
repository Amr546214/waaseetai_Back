/** Plain wording of a validity in minutes (the mail must state the REAL validity of the code it carries). */
export const otpValidityText = (minutes: number): string => (minutes === 1 ? 'دقيقة واحدة' : minutes === 2 ? 'دقيقتين' : minutes >= 3 && minutes <= 10 ? `${minutes} دقائق` : `${minutes} دقيقة`);
