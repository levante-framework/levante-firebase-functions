// Interfaces
import axios from "axios";
import Papa from "papaparse";
import { DocumentData } from "firebase-admin/firestore";

interface IRow {
  [key: string]: unknown;
}

interface IBaseScores {
  numAttempted: number;
  numCorrect: number;
  numIncorrect: number;
  thetaEstimate?: number | null;
  thetaSE?: number | null;
}
interface IRawScores {
  [key: string]: {
    practice?: IBaseScores;
    test?: IBaseScores;
  };
}

interface IComputedScores {
  [key: string]: {
    roarScore?: number | null;
    standardScore?: number | null;
    thetaEstimate?: number;
    wjPercentile?: number | null;
    percentile?: number | null;
    sreScore?: number;
    tosrecPercentile?: number | null;
    tosrecSS?: number | null;
    sprPercentile?: number | null;
    sprStandardScore?: number | null;
    sprPercentileString?: string | null;
    sprStandardScoreString?: string | null;
    ceilingFlag?: boolean | null;
    totalPercentCorrect?: number | null;
    totalCorrect?: number | null;
    totalNumAttempted?: number | null;
    subScore?: number | null;
    subPercentCorrect?: number | null;
  };
}

export interface IRunScores {
  raw: IRawScores;
  computed: IComputedScores | null;
}

// Constants
const tableUrl = {
  pa: "https://storage.googleapis.com/roar-pa/scores/pa_lookup_v3.csv",
  swr: "https://storage.googleapis.com/roar-swr/scores/swr_lookup_v6.csv",
  sre: "https://storage.googleapis.com/roar-sre/scores/sre_lookup_v3.csv",
  sreAi:
    "https://storage.googleapis.com/roar-sre/scores/sre_parallel_equating_lookup.csv",
};

const getTable = async (
  taskId: string,
  tableUrl: string,
): Promise<[string, IRow[]]> => {
  return new Promise((resolve) => {
    const table: IRow[] = [];

    const papaOptions = {
      header: true,
      dynamicTyping: true,
      skipEmptyLines: true,
    };

    axios
      .get(tableUrl, { responseType: "stream" })
      .then((response) => response.data)
      .then((stream) => {
        stream
          .pipe(Papa.parse(Papa.NODE_STREAM_INPUT, papaOptions))
          .on("data", (row) => {
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            const { "": _, ...rowData } = row as IRow;
            table.push(rowData);
          })
          .on("end", () => {
            resolve([taskId, table]);
          });
      });
  });
};

const tablePairs = Object.entries(tableUrl).map(([taskId, url]) =>
  getTable(taskId, url),
);
const tableEntries = await Promise.all(tablePairs);
const tables = Object.fromEntries(tableEntries);

export const percentCorrectTasks = [
  "letter",
  "letter-es",
  "morphology",
  "cva",
  "vocab",
  "trog",
];

export const rawScoreTasks = [
  "sre-es",
  "sre-pt",
  "fluency-arf",
  "fluency-calf",
  "fluency-arf-es",
  "fluency-calf-es",
];

// Functions

export const getAgeInMonths = (dob, timeStarted) => {
  const now = timeStarted ?? new Date();
  let months = (now.getFullYear() - dob.getFullYear()) * 12;
  months -= dob.getMonth() + 1;
  months += now.getMonth();
  if (now.getDate() >= dob.getDate()) months++;
  return months <= 0 ? 0 : months;
};

export const getSwrScores = (trials: DocumentData[], ageMonths?: number) => {
  const practiceTrials = trials.filter(
    (trial) => trial.assessment_stage === "practice_response",
  );
  const testTrials = trials.filter(
    (trial) => trial.assessment_stage === "test_response",
  );
  const lastTrial = testTrials.reduce(
    (prev, curr) => {
      return prev.trial_index > curr.trial_index ? prev : curr;
    },
    { trial_index: -1 },
  );
  const rawScores: IRawScores = {
    composite: {
      practice: {
        numAttempted: practiceTrials.length,
        numCorrect: practiceTrials.filter((trial) => Boolean(trial.correct))
          .length,
        numIncorrect: practiceTrials.filter((trial) => !trial.correct).length,
        thetaEstimate: null,
        thetaSE: null,
      },
      test: {
        numAttempted: testTrials.length,
        numCorrect: testTrials.filter((trial) => Boolean(trial.correct)).length,
        numIncorrect: testTrials.filter((trial) => !trial.correct).length,
        thetaEstimate: lastTrial.thetaEstimate ?? null,
        thetaSE: lastTrial.thetaSE ?? null,
      },
    },
  };

  const computedScores: IComputedScores = {
    composite: {
      thetaEstimate: lastTrial.thetaEstimate ?? null,
    },
  };

  if (ageMonths) {
    const ageMin = 72;
    const ageMax = 216;

    let ageForScore = ageMonths;
    if (ageMonths < ageMin) ageForScore = ageMin;
    if (ageMonths > ageMax) ageForScore = ageMax;

    const rounded = Number(lastTrial.thetaEstimate?.toFixed(1));

    if (rounded !== undefined) {
      const myRow = tables.swr.filter((row) => {
        return (
          Number(Number(row.ageMonths).toFixed(1)) === ageForScore &&
          Number(Number(row.thetaEstimate).toFixed(1)) === rounded
        );
      })[0];

      if (myRow !== undefined) {
        const { roarScore, standardScore, wjPercentile } = myRow;
        computedScores.composite.roarScore =
          roarScore != null ? Number(roarScore) : null;
        computedScores.composite.standardScore =
          standardScore != null ? Number(standardScore) : null;
        computedScores.composite.wjPercentile =
          wjPercentile != null ? Number(wjPercentile) : null;
      }
    }
  }

  return { raw: rawScores, computed: computedScores };
};

export const getPaScores = (
  trials: DocumentData[],
  ageMonths?: number,
  grade?: number,
) => {
  const practiceTrials = trials.filter(
    (trial) => trial.assessment_stage === "practice_response",
  );
  const testTrials = trials.filter(
    (trial) => trial.assessment_stage === "test_response",
  );

  const rawScores: IRawScores = {
    composite: {
      practice: {
        numAttempted: practiceTrials.length,
        numCorrect: practiceTrials.filter((trial) => Boolean(trial.correct))
          .length,
        numIncorrect: practiceTrials.filter((trial) => !trial.correct).length,
      },
      test: {
        numAttempted: testTrials.length,
        numCorrect: testTrials.filter((trial) => Boolean(trial.correct)).length,
        numIncorrect: testTrials.filter((trial) => !trial.correct).length,
      },
    },
  };

  const subtasks = [...new Set(trials.map((trial) => trial.subtask))].filter(
    (subtask) => subtask !== undefined,
  );
  for (const subtask of subtasks) {
    const subtaskTrials = {
      practice: practiceTrials.filter((trial) => trial.subtask === subtask),
      test: testTrials.filter((trial) => trial.subtask === subtask),
    };

    rawScores[subtask] = {
      practice: {
        numAttempted: subtaskTrials.practice.length,
        numCorrect: subtaskTrials.practice.filter((trial) =>
          Boolean(trial.correct),
        ).length,
        numIncorrect: subtaskTrials.practice.filter((trial) => !trial.correct)
          .length,
        thetaEstimate: null,
        thetaSE: null,
      },
      test: {
        numAttempted: subtaskTrials.test.length,
        numCorrect: subtaskTrials.test.filter((trial) => Boolean(trial.correct))
          .length,
        numIncorrect: subtaskTrials.test.filter((trial) => !trial.correct)
          .length,
        thetaEstimate: null,
        thetaSE: null,
      },
    };
  }

  const computedScores: IComputedScores = Object.fromEntries(
    Object.entries(rawScores).map(([corpus, scores]) => {
      const roarScore = scores.test?.numCorrect ?? 0;
      return [corpus, { roarScore }];
    }),
  );

  if (ageMonths && grade) {
    const ageMin = 48;
    const ageMax = 144;

    let ageForScore = ageMonths;
    if (ageMonths < ageMin) ageForScore = ageMin;
    if (ageMonths > ageMax) ageForScore = ageMax;

    const totalScore = computedScores.composite.roarScore;
    let myRow;

    if (grade < 6) {
      myRow = tables.pa.filter(
        (row) =>
          Number(row.ageMonths) === ageForScore && row.roarScore === totalScore,
      )[0];
    } else {
      myRow = tables.pa.filter(
        (row) => Number(row.grade) === grade && row.roarScore === totalScore,
      )[0];
    }

    if (myRow !== undefined) {
      const {
        standardScore,
        percentile,
        sprPercentile,
        sprPercentileString,
        sprStandardScore,
        sprStandardScoreString,
        ceilingFlag,
      } = myRow;
      computedScores.composite.standardScore =
        standardScore != null ? Number(standardScore) : null;
      computedScores.composite.percentile =
        percentile != null ? Number(percentile) : null;
      computedScores.composite.sprPercentile =
        sprPercentile != null ? Number(sprPercentile) : null;
      computedScores.composite.sprPercentileString =
        sprPercentileString != null ? String(sprPercentileString) : null;
      computedScores.composite.sprStandardScore =
        sprStandardScore != null ? Number(sprStandardScore) : null;
      computedScores.composite.sprStandardScoreString =
        sprStandardScoreString != null ? String(sprStandardScoreString) : null;
      computedScores.composite.ceilingFlag =
        ceilingFlag != null ? ceilingFlag === "TRUE" : null;
    }
  }

  return { raw: rawScores, computed: computedScores };
};

export const getSreScores = (
  trials: DocumentData[],
  grade?: number | string,
) => {
  const practiceTrials = trials.filter(
    (trial) => trial.assessment_stage === "practice_response",
  );
  const testTrials = trials.filter(
    (trial) => trial.assessment_stage === "test_response",
  );
  const subtasks = [...new Set(trials.map((trial) => trial.subtask))].filter(
    (subtask) => subtask !== undefined,
  );

  const rawScores: IRawScores = {};
  for (const corpus of subtasks) {
    let subtaskTrials = testTrials.filter((trial) => trial.subtask === corpus);
    let scoreKey = "test";
    if (corpus === "practice") {
      subtaskTrials = practiceTrials.filter(
        (trial) => trial.subtask === corpus,
      );
      scoreKey = "practice";
    }

    rawScores[corpus] = {
      [scoreKey]: {
        numAttempted: subtaskTrials.length,
        numCorrect: subtaskTrials.filter((trial) => Boolean(trial.correct))
          .length,
        numIncorrect: subtaskTrials.filter((trial) => !trial.correct).length,
        thetaEstimate: null,
        thetaSE: null,
      },
    };
  }

  rawScores.composite = {
    practice: {
      numAttempted: practiceTrials.length,
      numCorrect: practiceTrials.filter((trial) => Boolean(trial.correct))
        .length,
      numIncorrect: practiceTrials.filter((trial) => !trial.correct).length,
    },
    test: {
      numAttempted: testTrials.length,
      numCorrect: testTrials.filter((trial) => Boolean(trial.correct)).length,
      numIncorrect: testTrials.filter((trial) => !trial.correct).length,
    },
  };

  const computedScores: IComputedScores = Object.fromEntries(
    Object.entries(rawScores).map(([corpus, scores]) => {
      const scoreKey = corpus === "practice" ? "practice" : "test";
      const sreScore =
        (scores[scoreKey]?.numCorrect ?? 0) -
        (scores[scoreKey]?.numIncorrect ?? 0);
      return [corpus, { sreScore }];
    }),
  );

  // this function is to compute the composite score based on corpus (fitting a linear model)
  const computedScoreConversion = (score) => {
    if (score.lab?.sreScore) {
      return Math.max(score.lab.sreScore, 0);
    }
    if (score.aiV1P1?.sreScore) {
      const rawScore = Math.max(score.aiV1P1.sreScore, 0);
      const aiRow = tables.sreAi.find(
        (row) => row.rawScore === rawScore && row.form === "aiP1",
      );
      return aiRow?.sreScore as number | undefined;
    }
    if (score.aiV1P2?.sreScore) {
      const rawScore = Math.max(score.aiV1P2.sreScore, 0);
      const aiRow = tables.sreAi.find(
        (row) => row.rawScore === rawScore && row.form === "aiP2",
      );
      return aiRow?.sreScore as number | undefined;
    }
    return 0;
  };

  // computedScores should now have keys for each corpus: lab, ai, and tosrec, aiV1P1, aiV2P2
  // But for the composite score, we just take the score for the lab corpus
  // We also clip the composite score to a minimum of 0.
  const compositeScore = computedScoreConversion(computedScores);

  computedScores.composite = {
    sreScore: compositeScore,
  };

  if (grade) {
    const myRow = tables.sre.filter(
      (row) => Number(row.grade) === grade && row.sreScore === compositeScore,
    )[0];
    if (myRow !== undefined) {
      const { tosrecPercentile, tosrecSS, sprStandardScore, sprPercentile } =
        myRow;
      computedScores.composite.tosrecPercentile =
        tosrecPercentile != null ? Number(tosrecPercentile) : null;
      computedScores.composite.tosrecSS =
        tosrecSS != null ? Number(tosrecSS) : null;
      computedScores.composite.sprPercentile =
        sprPercentile != null ? Number(sprPercentile) : null;
      computedScores.composite.sprStandardScore =
        sprStandardScore != null ? Number(sprStandardScore) : null;
    }
  }

  return { raw: rawScores, computed: computedScores };
};

const joinMapOrArray = (sequence: string[] | { [key: string]: string }) => {
  try {
    return (sequence as string[]).join(",");
  } catch {
    return (Object.values(sequence) as string[]).join(",");
  }
};

export const getTotalPercentCorrectScores = (
  trials: DocumentData[],
  taskId: string,
) => {
  const practiceTrials = trials.filter(
    (trial) => trial.assessment_stage === "practice_response",
  );
  const testTrials = trials.filter(
    (trial) => trial.assessment_stage === "test_response",
  );

  const rawScores: IRawScores = {
    composite: {
      practice: {
        numAttempted: practiceTrials.length,
        numCorrect: practiceTrials.filter((trial) => Boolean(trial.correct))
          .length,
        numIncorrect: practiceTrials.filter((trial) => !trial.correct).length,
      },
      test: {
        numAttempted: testTrials.length,
        numCorrect: testTrials.filter((trial) => Boolean(trial.correct)).length,
        numIncorrect: testTrials.filter((trial) => !trial.correct).length,
      },
    },
  };

  const subtasks = [...new Set(trials.map((trial) => trial.subtask))].filter(
    (subtask) => subtask !== undefined,
  );
  for (const subtask of subtasks) {
    const subtaskTrials = {
      practice: practiceTrials.filter((trial) => trial.subtask === subtask),
      test: testTrials.filter((trial) => trial.subtask === subtask),
    };

    rawScores[subtask] = {
      practice: {
        numAttempted: subtaskTrials.practice.length,
        numCorrect: subtaskTrials.practice.filter((trial) =>
          Boolean(trial.correct),
        ).length,
        numIncorrect: subtaskTrials.practice.filter((trial) => !trial.correct)
          .length,
        thetaEstimate: null,
        thetaSE: null,
      },
      test: {
        numAttempted: subtaskTrials.test.length,
        numCorrect: subtaskTrials.test.filter((trial) => Boolean(trial.correct))
          .length,
        numIncorrect: subtaskTrials.test.filter((trial) => !trial.correct)
          .length,
        thetaEstimate: null,
        thetaSE: null,
      },
    };
  }

  const computedScores: IComputedScores = Object.fromEntries(
    Object.entries(rawScores).map(([subTask, subTaskScores]) => {
      const subScore = subTaskScores.test?.numCorrect ?? 0;
      let subPercentCorrect: number;
      if (
        subTaskScores.test?.numAttempted &&
        subTaskScores.test?.numAttempted !== 0
      ) {
        subPercentCorrect =
          (subTaskScores.test?.numCorrect ?? 0) /
          subTaskScores?.test?.numAttempted;
      } else {
        subPercentCorrect = 0;
      }
      if (taskId === "letter" || taskId === "letter-es") {
        // This method will need to be changed if Letter scoring is changed such that
        // It does not record Every letterNameUpper, letterNameLower,
        // And letterPhoneme score for each trial
        const lastTrial = testTrials.reduce(
          (prev, curr) => {
            return prev.trial_index > curr.trial_index ? prev : curr;
          },
          { trial_index: -1 },
        );

        try {
          const lowerCorrect = joinMapOrArray(lastTrial.lowerCorrect ?? []);
          const lowerIncorrect = joinMapOrArray(lastTrial.lowerIncorrect ?? []);
          const upperCorrect = joinMapOrArray(lastTrial.upperCorrect ?? []);
          const upperIncorrect = joinMapOrArray(lastTrial.upperIncorrect ?? []);
          const phonemeCorrect = joinMapOrArray(lastTrial.phonemeCorrect ?? []);
          const phonemeIncorrect = joinMapOrArray(
            lastTrial.phonemeIncorrect ?? [],
          );

          return [
            subTask,
            {
              subScore,
              subPercentCorrect,
              lowerCorrect,
              lowerIncorrect,
              upperCorrect,
              upperIncorrect,
              phonemeCorrect,
              phonemeIncorrect,
            },
          ];
        } catch (e) {
          console.log("lastTrail", lastTrial);
          throw e;
        }
      }
      return [subTask, { subScore, subPercentCorrect }];
    }),
  );
  const totalCorrect =
    rawScores.composite.test?.numCorrect &&
    rawScores.composite.test?.numCorrect !== 0
      ? rawScores.composite.test?.numCorrect
      : 0;
  const totalNumAttempted = rawScores.composite.test?.numAttempted;
  const totalPercentCorrect =
    totalNumAttempted && totalNumAttempted !== 0
      ? totalCorrect / totalNumAttempted
      : 0;

  computedScores.composite = {
    totalCorrect: totalCorrect,
    totalNumAttempted: totalNumAttempted,
    totalPercentCorrect: totalPercentCorrect,
  };
  return { raw: rawScores, computed: computedScores };
};

export const getRawScores = (trials: DocumentData[]) => {
  const practiceTrials = trials.filter(
    (trial) => trial.assessment_stage === "practice_response",
  );
  const testTrials = trials.filter(
    (trial) => trial.assessment_stage === "test_response",
  );

  const rawScores: IRawScores = {
    composite: {
      practice: {
        numAttempted: practiceTrials.length,
        numCorrect: practiceTrials.filter((trial) => Boolean(trial.correct))
          .length,
        numIncorrect: practiceTrials.filter((trial) => !trial.correct).length,
      },
      test: {
        numAttempted: testTrials.length,
        numCorrect: testTrials.filter((trial) => Boolean(trial.correct)).length,
        numIncorrect: testTrials.filter((trial) => !trial.correct).length,
      },
    },
  };

  const subtasks = [...new Set(trials.map((trial) => trial.subtask))].filter(
    (subtask) => subtask !== undefined,
  );
  for (const subtask of subtasks) {
    const subtaskTrials = {
      practice: practiceTrials.filter((trial) => trial.subtask === subtask),
      test: testTrials.filter((trial) => trial.subtask === subtask),
    };

    rawScores[subtask] = {
      practice: {
        numAttempted: subtaskTrials.practice.length,
        numCorrect: subtaskTrials.practice.filter((trial) =>
          Boolean(trial.correct),
        ).length,
        numIncorrect: subtaskTrials.practice.filter((trial) => !trial.correct)
          .length,
        thetaEstimate: null,
        thetaSE: null,
      },
      test: {
        numAttempted: subtaskTrials.test.length,
        numCorrect: subtaskTrials.test.filter((trial) => Boolean(trial.correct))
          .length,
        numIncorrect: subtaskTrials.test.filter((trial) => !trial.correct)
          .length,
        thetaEstimate: null,
        thetaSE: null,
      },
    };
  }

  return { raw: rawScores, computed: null };
};
