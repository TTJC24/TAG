# Worker application

PostgreSQL-backed worker for deterministic classification and recommendation.
It leases transactional-outbox commands, applies bounded retry/dead-letter
policy, and advances workflows only through the database transition function.
PostgreSQL—not Redis or worker memory—owns state and attempts.
