import { db } from "../../db/index.js";
import { readFile } from "../storage.js";
import { DATA_VER, readInput } from "./inspect.js";

/**
 * The files of the given kinds for a client and year, each with the data read from it. A file read by an older reader
 * (or whose data was never kept) is read again from storage and the result is kept.
 */
export async function loadFiles({ firmId, clientId, fy, kinds, clientGstin }) {
  const rows = await db.query(
    "select * from input_recon_files where firm_id=$1 and client_id=$2 and fy=$3 and kind = any($4::text[]) order by period nulls last, created_at",
    [firmId, clientId, fy, kinds],
  );
  const out = [];
  for (const f of rows) {
    let { data, info } = f;
    if (!(data && f.data_ver === DATA_VER)) {
      try {
        const again = await readInput(f.kind, await readFile(f.storage_path), f.original_filename, { clientGstin, fy });
        data = again.data;
        info = again.info;
        await db.query("update input_recon_files set data=$2::jsonb, data_ver=$3, info=$4::jsonb where id=$1", [f.id, data ? JSON.stringify(data) : null, DATA_VER, JSON.stringify(info)]);
      } catch { /* the file is gone from storage: it is listed as not read */ }
    }
    out.push({ id: f.id, kind: f.kind, name: f.original_filename, period: f.period, at: f.created_at ? new Date(f.created_at).getTime() : 0, info, data });
  }
  return out;
}
