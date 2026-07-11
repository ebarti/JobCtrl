WITH current_events AS (
  SELECT * FROM consented_product_events
  WHERE expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
), metrics AS (
  SELECT release, 'timing' AS metric, COALESCE(timing_metric, '') AS dimension_1,
         COALESCE(metric_bucket, '') AS dimension_2, COUNT(*) AS events,
         COUNT(DISTINCT visitor_hash) AS unique_visitors,
         COUNT(DISTINCT session_hash) AS unique_sessions
  FROM current_events WHERE event_name = 'demo_timing'
  GROUP BY release, timing_metric, metric_bucket
  UNION ALL
  SELECT release, 'cta', event_name, COALESCE(route_name, ''), COUNT(*),
         COUNT(DISTINCT visitor_hash), COUNT(DISTINCT session_hash)
  FROM current_events WHERE event_name IN ('demo_docs_cta_clicked', 'demo_install_cta_clicked')
  GROUP BY release, event_name, route_name
)
SELECT 'consented traffic' AS population, * FROM metrics
ORDER BY release, metric, dimension_1, dimension_2;
