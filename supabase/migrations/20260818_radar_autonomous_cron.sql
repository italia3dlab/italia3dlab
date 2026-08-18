-- Radar 3D autonomous schedule.
-- Prerequisite: create the Supabase Vault secret `radar_cron_anon_key`.
-- The secret value is intentionally not committed to GitHub.

create extension if not exists pg_cron with schema pg_catalog;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'radar-autonomous-rome-8am') then
    perform cron.unschedule('radar-autonomous-rome-8am');
  end if;
end $$;

select cron.schedule(
  'radar-autonomous-rome-8am',
  '5 6,7 * * *',
  $cron$
    select net.http_post(
      url := 'https://sisjcxpbpcqxkhxukhya.supabase.co/functions/v1/radar-autonomous',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'radar_cron_anon_key' limit 1),
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'radar_cron_anon_key' limit 1)
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 120000
    );
  $cron$
);