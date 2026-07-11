WITH current_events AS (
  SELECT * FROM consented_product_events
  WHERE expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
), funnel AS (
  SELECT release, 'core_funnel' AS metric,
         CASE
           WHEN event_name = 'demo_session_started' THEN '01_session'
           WHEN route_name = 'job_detail' THEN '02_job_detail'
           WHEN route_name = 'evidence' THEN '03_evidence'
           WHEN route_name = 'tailor' THEN '04_tailor'
           WHEN route_name = 'apply_review' THEN '05_apply_review'
           WHEN route_name = 'apply_dry_run' THEN '06_apply_dry_run'
           WHEN event_name = 'demo_install_cta_clicked' THEN '07_install_cta'
         END AS dimension_1,
         '' AS dimension_2,
         COUNT(*) AS events,
         COUNT(DISTINCT visitor_hash) AS unique_visitors,
         COUNT(DISTINCT session_hash) AS unique_sessions
  FROM current_events
  WHERE event_name = 'demo_session_started'
     OR event_name = 'demo_install_cta_clicked'
     OR (event_name = 'demo_route_viewed' AND route_name IN ('job_detail', 'evidence', 'tailor', 'apply_review', 'apply_dry_run'))
  GROUP BY release, dimension_1
)
SELECT 'consented traffic' AS population, * FROM funnel
ORDER BY release, dimension_1;
