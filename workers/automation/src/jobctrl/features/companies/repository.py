"""SQLite Companies adapter and its atomic source/receipt publication boundary."""

from __future__ import annotations

from contextlib import contextmanager
import json


def _json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


class SqliteCompanyUnitOfWork:
    def __init__(self, connection, jobs, model, events):
        self._connection, self._jobs, self._model, self._events = connection, jobs, model, events

    def posting(self, job_id):
        return self._jobs.get_posting_snapshot(job_id, connection=self._connection)

    def assert_posting_current(self, job_id, revision, source_hash):
        return self._jobs.assert_posting_current(job_id, revision, source_hash, connection=self._connection)

    def receipt(self, receipt_id):
        return self._model.receipt(receipt_id, connection=self._connection)

    def _latest(self, table, key, value):
        # Table/key names are selected only by these semantic adapter methods.
        row = self._connection.execute(
            f"SELECT revision,payload_json FROM companies_{table} WHERE {key}=? ORDER BY revision DESC LIMIT 1", (value,)
        ).fetchone()
        return {**json.loads(row["payload_json"]), "revision": row["revision"]} if row else None

    def configuration(self, company_id, revision=None):
        if revision is None:
            return self._latest("configurations", "company_id", company_id)
        row = self._connection.execute(
            "SELECT revision,payload_json FROM companies_configurations WHERE company_id=? AND revision=?",
            (company_id, revision),
        ).fetchone()
        return {**json.loads(row["payload_json"]), "revision": row["revision"]} if row else None

    def link(self, job_id):
        return self._latest("links", "job_id", job_id)

    def accepted(self, company_id):
        return self._latest("accepted", "company_id", company_id)

    def attempt(self, company_id):
        return self._latest("attempts", "company_id", company_id)

    def determination(self, company_id, fingerprint):
        row = self._connection.execute(
            "SELECT * FROM companies_determinations WHERE fingerprint=? AND company_id=?", (fingerprint, company_id)
        ).fetchone()
        if row is None:
            return None
        return {"receipt_id": row["receipt_id"], "configuration_id": row["configuration_id"],
                "sources": json.loads(row["sources_json"]), "result": json.loads(row["result_json"])}

    def recent_linked_jobs(self, limit):
        return [row[0] for row in self._connection.execute(
            "SELECT l.job_id FROM companies_links l WHERE l.revision="
            "(SELECT max(n.revision) FROM companies_links n WHERE n.job_id=l.job_id) ORDER BY l.revision DESC LIMIT ?",
            (limit,),
        )]

    def record_configuration(self, company_id, value):
        self._connection.execute("INSERT INTO companies_configurations(company_id,payload_json) VALUES (?,?)", (company_id, _json(value)))

    def record_link(self, job_id, company_id, value):
        self._connection.execute("INSERT INTO companies_links(job_id,company_id,payload_json) VALUES (?,?,?)", (job_id, company_id, _json(value)))

    def record_determination(self, fingerprint, company_id, receipt_id, configuration_id, sources, result):
        self._connection.execute("INSERT OR IGNORE INTO companies_determinations VALUES(?,?,?,?,?,?)", (
            fingerprint, company_id, receipt_id, configuration_id, _json(sources), _json(result),
        ))

    def record_accepted(self, company_id, value):
        self._connection.execute("INSERT INTO companies_accepted(company_id,payload_json) VALUES (?,?)", (company_id, _json(value)))

    def record_attempt(self, company_id, value):
        self._connection.execute("INSERT INTO companies_attempts(company_id,payload_json) VALUES (?,?)", (company_id, _json(value)))

    def _notify_job(self, company_id, job_id):
        self._events.append(self._connection, "CompanyBriefingUpdated", {"companyId": company_id, "jobId": job_id},
                            feature="companies", aggregate_id=company_id)

    def notify_linked_jobs(self, company_id):
        rows = self._connection.execute(
            "SELECT l.job_id FROM companies_links l WHERE l.company_id=? "
            "AND l.revision=(SELECT max(n.revision) FROM companies_links n WHERE n.job_id=l.job_id)", (company_id,),
        ).fetchall()
        for row in rows:
            self._notify_job(company_id, row[0])

    def delete_job_links(self, job_id):
        link = self.link(job_id)
        self._connection.execute("DELETE FROM companies_links WHERE job_id=?", (job_id,))
        if link:
            self._notify_job(link["companyId"], job_id)


class SqliteCompanyHistory:
    def __init__(self, database, jobs, model, events):
        self._database, self._jobs, self._model, self._events = database, jobs, model, events

    def _unit(self, connection):
        return SqliteCompanyUnitOfWork(connection, self._jobs, self._model, self._events)

    @contextmanager
    def read(self):
        with self._database.connect() as connection:
            connection.execute("BEGIN")
            yield self._unit(connection)

    @contextmanager
    def write(self):
        with self._database.transaction() as connection:
            yield self._unit(connection)

    @contextmanager
    def deletion(self, transaction=None):
        if transaction is None:
            with self.write() as unit:
                yield unit
        else:
            yield self._unit(transaction)
