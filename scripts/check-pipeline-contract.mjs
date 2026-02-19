import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const defaultContractPath = path.resolve(repoRoot, '../levante-support/schema_tools/PIPELINE_DATA_CONTRACT.json');
const contractPath = process.env.PIPELINE_CONTRACT_PATH || defaultContractPath;
const saveSurveyResultsPath = path.resolve(
  repoRoot,
  'functions/levante-admin/src/save-survey-results.ts',
);

function fail(message) {
  console.error(`[contract-check] ${message}`);
  process.exit(1);
}

if (!fs.existsSync(contractPath))
  fail(`Contract file not found at "${contractPath}". Set PIPELINE_CONTRACT_PATH to override.`);

const contractRaw = fs.readFileSync(contractPath, 'utf8');
const contract = JSON.parse(contractRaw);
const surveyContract = contract?.firestoreContracts?.surveyResponses;

if (!surveyContract) fail('Missing firestoreContracts.surveyResponses in contract artifact.');
if (surveyContract.collectionPath !== 'users/{uid}/surveyResponses/{surveyId}')
  fail('Unexpected surveyResponses collectionPath in contract.');
if (surveyContract.documentIdPolicy?.expectedDocIdField !== 'administrationId')
  fail('surveyResponses expectedDocIdField must be administrationId.');
if (surveyContract.uniqueness?.maxDocumentsPerScope !== 1)
  fail('surveyResponses maxDocumentsPerScope must be 1.');

if (!fs.existsSync(saveSurveyResultsPath)) fail(`Source file not found at "${saveSurveyResultsPath}".`);

const source = fs.readFileSync(saveSurveyResultsPath, 'utf8');
const requiredPatterns = [
  /surveyResponsesCollection\.doc\(administrationId\)/,
  /administrationId,\s*\n\s*pageNo,\s*\n\s*updatedAt:/m,
  /transaction\.set\(surveyRef,\s*updateData,\s*\{\s*merge:\s*true\s*\}\)/,
  /throw new Error\("administrationId is undefined or null"\)/,
];

for (const pattern of requiredPatterns) {
  if (!pattern.test(source)) fail(`Source check failed for pattern: ${pattern}`);
}

console.log('[contract-check] OK: save-survey-results matches PIPELINE_DATA_CONTRACT invariants.');
