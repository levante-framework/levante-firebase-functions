/**
 * Determines the school level based on the provided grade.
 *
 * @param {string} grade - The grade to determine the school level for.
 * @returns The school level as a string: "elementary", "middle", "high", "postsecondary", or null if the grade is invalid.
 */
export const getSchoolLevel = (grade: string) => {
  if (Number.isNaN(parseInt(grade, 10))) {
    // Then examine string to determine grade level
    if (["kindergarten", "k"].includes(grade.toLowerCase())) {
      return "elementary";
    } else if (
      [
        "prekindergarten",
        "transitionalkindergarten",
        "infanttoddler",
        "preschool",
        "pk",
        "tk",
      ].includes(grade.toLowerCase())
    ) {
      // Consider renaming
      return "early-childhood";
    } else if (grade.toLowerCase() === "postgraduate") {
      return "postsecondary";
    }
    return null;
  } else {
    const gradeNumeric = parseInt(grade, 10);
    if (gradeNumeric >= 0 && gradeNumeric < 6) {
      return "elementary";
    } else if (gradeNumeric >= 6 && gradeNumeric < 9) {
      return "middle";
    } else if (gradeNumeric >= 9 && gradeNumeric < 13) {
      return "high";
    } else if (gradeNumeric >= 13) {
      return "postsecondary";
    }
    return null;
  }
};
