# Levante Firebase Functions

This repository contains a collection of Firebase functions for the Levante platform. The functions are organized into separate directories:
                        |

| `levante-admin`      | Contains Firebase functions for the hs-levante-admin and hs-levante-admin-dev projects                           |

| `levante-assessment` | Contains Firebase functions for hs-levante-assessment and hs-levante-assessment-dev projects. (To be sunset.)                    |

| `local`         | Contains "local" functions for one off use cases (ex. transfering user data to another account).

## Getting Started

To get started with the Levante Firebase Functions, follow these steps:

1. Install the necessary dependencies:

```bash
npm install
```

2. Build the functions (From the root folder):

```bash
npm run build
```

## Firebase Emulator Development

The project includes comprehensive Firebase emulator support for local development with seed data.

### Prerequisites

Before running the Firebase emulators, ensure you have the following installed:

- **Node.js** (version 20 or higher)
- **Java** (version 21 or higher) - Required for Firebase emulators
  - On **macOS**: Install using Homebrew: `brew install openjdk@21`
  - On **Windows**: Download from [Oracle JDK](https://www.oracle.com/java/technologies/downloads/) or use [OpenJDK](https://openjdk.java.net/)
  - On **Linux**: Use your package manager (e.g., `sudo apt install openjdk-21-jdk` on Ubuntu)

Above is the easiest way to install Java. You can also download the binaries directly from the [Oracle website](https://www.oracle.com/java/technologies/downloads/) .

NOTE: Current version numbers above are LTS versions at the time of writing.

### Quick Start

```bash
# Start emulators with data persistence
npm run dev

# Fill the emulator environment with seed data
npm run emulator:seed
```


### Database Seeding Scripts

The emulator includes a comprehensive seeding system that creates test users, groups, and data relationships:

#### Test Users Created
| User Type | Email | Password | Description |
|-----------|-------|----------|-------------|
| Super Admin | superadmin@levante.test | super123 | Super Admin user |
| Admin | admin@levante.test | admin123 | Admin user |
| Teacher | teacher@levante.test | teach123 | Participant user (teacher) |
| Student | student@levante.test | student123 | Participant user (student) |
| Parent | parent@levante.test | parent123 | Participant user (parent) |

#### Groups Created
- **District**: "Test District" (ID: test-district-1)
- **School**: "Test Elementary School" (ID: test-school-1)  
- **Class**: "3rd Grade - Room 101" (ID: test-class-1)
- **Group**: "Reading Intervention Cohort" (ID: test-group-1)

#### Available Commands

```bash
# Database Management
npm run emulator:clear           # Clear all data from emulator
npm run emulator:seed            # Seed database with test data
npm run emulator:reset           # Clear + seed (fresh start)

# Utility Commands
npm run emulator:export          # Export current emulator data for backup

# Kill emulators (if needed)
pkill -f firebase

# Reset without scripts
rm -rf emulator_data && npm run dev:clean
```

### Typical Development Workflow

1. **Start emulators**:
   ```bash
   npm run dev
   ```

2. **Set up test data**:
   ```bash
   npm run emulator:setup
   ```

3. **Develop and test** your application with the created users

4. **Reset data when needed**:
   ```bash
   npm run emulator:setup  # Fresh start
   ```

### User Claims & Permissions

- **Super Admin**: Has `super_admin: true` and access to all groups
- **Admin**: Has limited group access with admin privileges
- **Participants** (Teacher/Student/Parent): No admin claims, associated with groups via user document associations

All participant users are automatically linked to the test group (cohort) and groups according to their user type.


## Deployment

Levante functions are deployed automatically when merged to the `main` branch. If you would like to deploy functions locally, follow these steps:

1. Build the functions as above

2. Navigate to the project that you would like to deploy.

   For example, to deploy functions in `levante-admin`,

   ```bash
   cd functions/levante-admin
   ```

3. Deploy the functions


   ~To deploy only certain functions, first select either the dev or prod environment. For example, to select the dev environment, use

   ```bash
   npx firebase use dev
   ```

   Then deploy a function by name. For example, to deploy only the `exampleFunction` function, use

   ```bash
   npx firebase deploy --only functions:dashboard-functions:exampleFunction
   ```

   Note that you must use the `npx firebase` command, rather than the default `firebase` command. The latter will fail.
   Also note that if changes were made to functions located in a separate directory (e.g. functions/common), make sure to run `npm run build:all` prior to deployment. This will build and update the changed directory.

   - Deploy all the functions

   To deploy all of the functions, you can use the supplied `npm run` scripts:

   ```bash
   npm run deploy:dev  # For deployment to the dev environment
   ```

   or

   ```bash
   npm run deploy:prod  # For deployment to the prod environment
   ```


## License

This project is a derivative of ROAR's original version, which is licensed under the [Stanford Academic Software License for ROAR](LICENSE). 
