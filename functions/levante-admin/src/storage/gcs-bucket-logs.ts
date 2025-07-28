import { Storage } from "@google-cloud/storage";
import { logger } from "firebase-functions/v2";
import { StorageEvent } from "firebase-functions/v2/storage";

// This function moves log files for a given roar app bucket
// To a directory structure based on the date
export const createOrganizeBucketLogsByDateHandler = async (
  bucketName: string
) => {
  return async (event: StorageEvent) => {
    logger.debug("Function handleOrganizeBucketLogsByDate called.");

    const storage = new Storage();

    const object = event.data;
    const targetBucketName = bucketName;
    const filePath = object.name;
    const fileSegments = filePath?.split("/");

    if (!fileSegments) {
      console.log(`File with path ${filePath} is not found.`);
      return;
    }

    if (fileSegments.length < 2 || !filePath?.includes("-logs/")) {
      console.log(`The file ${filePath} is not in a logs subdirectory.`);
      return;
    }

    // example: roar-swr-logs/
    const originalLogDirectory = fileSegments?.slice(0, 1).join("/");
    const fileName = fileSegments?.slice(-1)[0];
    const date = new Date();
    const year = date.getFullYear();
    const month = ("0" + (date.getMonth() + 1)).slice(-2);
    const day = ("0" + date.getDate()).slice(-2);
    // example: roar-swr-logs/2021/08/01/
    const newFilePath = `${originalLogDirectory}/${year}/${month}/${day}/${fileName}`;

    // Check if the file is already in the target directory to prevent recursive calls
    if (newFilePath === filePath) {
      logger.debug(
        `File ${filePath} is already in the target directory; terminating function.`
      );
      return;
    }

    await storage
      .bucket(targetBucketName)
      .file(filePath)
      .move(storage.bucket(targetBucketName).file(newFilePath));
    // example: roar-bucket-logs/roar-swr-logs/2021/08/01/
    logger.debug(`File ${filePath} has been moved to ${newFilePath}.`);
  };
};
