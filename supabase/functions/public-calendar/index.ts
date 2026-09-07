import { createCalendarHandler } from './handler.mjs';
import { convertCalendar } from '../../../tools/icloud-calendar/convert.mjs';

// No Supabase database client or account credentials are needed for this feed.
const handler = createCalendarHandler({
  sourceURL: Deno.env.get('CHURCH_CALENDAR_URL'),
  convert: convertCalendar,
});

Deno.serve(handler);
