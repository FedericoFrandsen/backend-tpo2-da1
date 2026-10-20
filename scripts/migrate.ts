import { createDatabase } from "../src/database";
const db = createDatabase();
db.$client.close();
console.log("Migraciones de Hallado aplicadas.");
