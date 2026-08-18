create extension if not exists pg_cron with schema pg_catalog;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'events-autonomous-monday-rome-7am') then
    perform cron.unschedule('events-autonomous-monday-rome-7am');
  end if;
end $$;

select cron.schedule(
  'events-autonomous-monday-rome-7am',
  '40 5,6 * * 1',
  $cron$
    select net.http_post(
      url := 'https://sisjcxpbpcqxkhxukhya.supabase.co/functions/v1/events-autonomous',
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