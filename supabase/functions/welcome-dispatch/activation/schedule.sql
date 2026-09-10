-- REVIEW-ONLY infrastructure step. Do not apply until the exact release is approved.
-- Uses the existing church project only; no recipient addresses or secret literals.
-- pg_cron and pg_net are not currently installed (read-only check 2026-09-09).
-- Install them through a reviewed migration first. Never repurpose an existing job.
begin;
do $guard$
begin
  if not exists(select 1 from pg_extension where extname='pg_cron')
    or not exists(select 1 from pg_extension where extname='pg_net')
    or not exists(select 1 from pg_extension where extname='supabase_vault') then
    raise exception 'Scheduler extensions are not ready';
  end if;
  if (select count(*) from vault.decrypted_secrets where name='creek_welcome_job_secret' and length(decrypted_secret) between 32 and 256 and decrypted_secret ~ '^[A-Za-z0-9_-]+$')<>1 then
    raise exception 'Exactly one valid dedicated scheduler secret is required';
  end if;
  if exists(select 1 from cron.job where jobname='creek-intake-dispatch') then
    raise exception 'Job already exists; inspect it before any change';
  end if;
end $guard$;
select cron.schedule('creek-intake-dispatch','* * * * *',$job$
  select net.http_post(
    url := 'https://xzfeumdonxeodqhfirjr.supabase.co/functions/v1/welcome-dispatch',
    headers := jsonb_build_object('Content-Type','application/json','x-creek-job-secret',
      (select decrypted_secret from vault.decrypted_secrets where name='creek_welcome_job_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
$job$);
commit;
