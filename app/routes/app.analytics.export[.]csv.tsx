// Daily points series for the chosen period, one row per Karachi day.
import type { LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { parsePeriodKey, periodRange } from "../components/karachi";
import { SERIES_CSV_COLUMNS } from "../lib/admin-analytics.server";
import { getPointsSeries } from "../lib/admin-data.server";
import { csvResponse, toCsv } from "../lib/csv.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const period = periodRange(parsePeriodKey(new URL(request.url).searchParams.get("period"), true));
  const series = await getPointsSeries(period.from, period.to);
  return csvResponse(`points-by-day-${period.key}.csv`, toCsv(series, SERIES_CSV_COLUMNS));
};
