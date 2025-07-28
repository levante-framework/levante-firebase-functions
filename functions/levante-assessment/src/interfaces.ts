/**
 * An interface representing start and stop dates for an organization.
 */
export interface IOrgDateMap {
  /* The ID of the organization. */
  [x: string]: {
    /* The date the user joined the organization. */
    from: Date;
    /* The date the user left the organization, if applicable. */
    to?: Date;
  };
}

/**
 * An interface representing the organizations that a user belongs to.
 */
export interface IOrgsMap {
  /* An array of the current organizations. */
  current: string[];
  /* An array of all the organizations, past and present */
  all: string[];
  /* An interface representing a map of start and stop dates for each organization. */
  dates: IOrgDateMap;
}
