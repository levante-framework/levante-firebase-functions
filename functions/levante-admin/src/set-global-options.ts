import { setGlobalOptions } from "firebase-functions/v2";

setGlobalOptions({ timeoutSeconds: 540, memory: "512MiB" });
