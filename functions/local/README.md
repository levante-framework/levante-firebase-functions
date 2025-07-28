# Local ROAR Firebase Admin Functions

## Setup

These functions require two environment variables to be set:

- ROAR_ADMIN_FIREBASE_CREDENTIALS
- ROAR_ASSESSMENT_FIREBASE_CREDENTIALS

Each of these should point to a file containing the service account key for the admin and assessment firebase projects, respectively. See the [admin-SDK setup instructions](https://firebase.google.com/docs/admin/setup/#initialize_the_sdk_in_non-google_environments) for more details.

It might be helpful to set these environment variables in your `.zshrc` file (or similar shell setup files).
For example,

```bash
export ROAR_ADMIN_FIREBASE_CREDENTIALS=path/to/credentials/for/admin/project.json
export ROAR_ASSESSMENT_FIREBASE_CREDENTIALS=path/to/credentials/for/assessment/project.json`
```

## Functions

This section describes each of the npm scripts available to you.

- `npm run toggle-super-admin` will toggle the `super_admin` custom claim for a given ROAR UID. You must pass the ROAR UID as an argument to this script using the following syntax:

  ```bash
  # Not the space separating the -- from the ROAR_UID argument
  npm run toggle-super-admin -- ROAR_UID
  ```
