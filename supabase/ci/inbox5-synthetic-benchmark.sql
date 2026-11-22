-- SOF-80 synthetic-only benchmark. Isolated temporary snapshot-shaped data,
-- NOT a production or a fully populated WACRM RPC SLA proof.
\set ON_ERROR_STOP on
\timing on
BEGIN;
CREATE TEMP TABLE inbox_bench_threads(account_id uuid NOT NULL, id uuid NOT NULL,
 channel_id uuid NOT NULL,last_message_at timestamptz, unread_count_known integer NOT NULL)
 ON COMMIT DROP;
CREATE TEMP TABLE inbox_bench_messages(account_id uuid NOT NULL, thread_id uuid NOT NULL,
 id uuid NOT NULL, created_at timestamptz) ON COMMIT DROP;
-- 10k thread rows and 100k source-shaped messages for a single synthetic tenant.
INSERT INTO inbox_bench_threads
SELECT '10000000-0000-4000-8000-000000000001'::uuid,
 ('20000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
 '30000000-0000-4000-8000-000000000001'::uuid,
 '2026-11-21T23:00:00Z'::timestamptz - (n/2)*interval '1 second',
 n%4 FROM generate_series(1,10000) n;
-- Skewed realistic distribution: 1k active threads have 50 messages,
-- remaining 9k threads share the other 50k (5-6 per thread).
INSERT INTO inbox_bench_messages
SELECT '10000000-0000-4000-8000-000000000001'::uuid,
 ('20000000-0000-4000-8000-'||lpad((CASE WHEN i<=50000 THEN ((i-1)%1000)+1 ELSE 1001+((i-50001)%9000) END)::text,12,'0'))::uuid,
 ('40000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,
 '2026-11-21T23:00:00Z'::timestamptz-(i%4000)*interval '1 minute'
FROM generate_series(1,100000) g(i);
CREATE INDEX inbox_bench_list_idx ON inbox_bench_threads(account_id,last_message_at DESC NULLS LAST,id DESC);
CREATE INDEX inbox_bench_history_idx ON inbox_bench_messages(thread_id,created_at DESC NULLS LAST,id DESC);
ANALYZE inbox_bench_threads;
ANALYZE inbox_bench_messages;
DO $check$
DECLARE t bigint; m bigint;
BEGIN
 SELECT count(*) INTO t FROM inbox_bench_threads;
 SELECT count(*) INTO m FROM inbox_bench_messages;
 IF t<>10000 OR m<>100000 OR (SELECT count(*) FROM inbox_bench_messages WHERE thread_id='20000000-0000-4000-8000-000000000001')<>50 THEN RAISE EXCEPTION 'INBOX5_BAD_SYNTHETIC_FIXTURE: % %',t,m; END IF;
 RAISE NOTICE 'INBOX5_SYNTHETIC_SIZE threads=% messages=%',t,m;
END $check$;
\echo INBOX5 synthetic list plan:
EXPLAIN (ANALYZE,BUFFERS)
SELECT id,last_message_at FROM inbox_bench_threads
WHERE account_id='10000000-0000-4000-8000-000000000001'
AND (last_message_at,id)<('2026-11-21T22:55:00Z'::timestamptz,'20000000-0000-4000-8000-000000000900'::uuid)
ORDER BY last_message_at DESC NULLS LAST,id DESC LIMIT 31;
\echo INBOX5 synthetic history plan:
EXPLAIN (ANALYZE,BUFFERS)
SELECT id,created_at FROM inbox_bench_messages
WHERE thread_id='20000000-0000-4000-8000-000000000001'
ORDER BY created_at DESC NULLS LAST,id DESC LIMIT 51;
CREATE TEMP TABLE inbox_bench_samples(operation text NOT NULL,elapsed_ms numeric NOT NULL) ON COMMIT DROP;
DO $bench$
DECLARE started timestamptz; observed_rows bigint; n integer;
BEGIN
 FOR n IN 1..35 LOOP
  started=clock_timestamp();
  SELECT count(*) INTO observed_rows FROM (
   SELECT id FROM inbox_bench_threads
   WHERE account_id='10000000-0000-4000-8000-000000000001'
   AND (last_message_at,id)<('2026-11-21T22:55:00Z'::timestamptz,'20000000-0000-4000-8000-000000000900'::uuid)
   ORDER BY last_message_at DESC NULLS LAST,id DESC LIMIT 31
  ) bounded;
  INSERT INTO inbox_bench_samples VALUES('list',extract(epoch FROM clock_timestamp()-started)*1000);
  started=clock_timestamp();
  SELECT count(*) INTO observed_rows FROM (
   SELECT id FROM inbox_bench_messages
   WHERE thread_id='20000000-0000-4000-8000-000000000001'
   ORDER BY created_at DESC NULLS LAST,id DESC LIMIT 51
  ) bounded;
  INSERT INTO inbox_bench_samples VALUES('history',extract(epoch FROM clock_timestamp()-started)*1000);
 END LOOP;
END $bench$;
\echo INBOX5 synthetic p50/p95 ms and sample size:
SELECT operation,count(*) AS runs,round(percentile_cont(0.5) WITHIN GROUP(ORDER BY elapsed_ms)::numeric,3) AS p50_ms,
 round(percentile_cont(0.95) WITHIN GROUP(ORDER BY elapsed_ms)::numeric,3) AS p95_ms,
 round(max(elapsed_ms),3) AS max_ms FROM inbox_bench_samples GROUP BY operation ORDER BY operation;
DO $budget$
DECLARE worst numeric;
BEGIN
 SELECT max(p95) INTO worst FROM
  (SELECT percentile_cont(0.95) WITHIN GROUP(ORDER BY elapsed_ms) AS p95
   FROM inbox_bench_samples GROUP BY operation) x;
 IF worst>500 THEN RAISE EXCEPTION 'INBOX5_SYNTHETIC_OVER_500MS: %',worst; END IF;
 RAISE NOTICE 'INBOX5_SYNTHETIC_500MS_QUERY_BUDGET_PASS p95_max_ms=%',worst;
END $budget$;
ROLLBACK;
