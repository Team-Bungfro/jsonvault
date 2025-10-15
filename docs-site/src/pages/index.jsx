import React from "react";
import clsx from "clsx";
import Link from "@docusaurus/Link";
import Layout from "@theme/Layout";

import styles from "./index.module.css";

const features = [
  {
    title: "Document-first",
    description:
      "Store, query, and stream JSON documents without running a separate server. JSONVault keeps everything in inspectable files inside your repository.",
  },
  {
    title: "Powerful tooling",
    description:
      "Schemas, hooks, SQL with joins, migrations, a durable change log, and a CLI come included. No plugins required.",
  },
  {
    title: "Ready for production",
    description:
      "Field-level encryption, TTL indexes, partitioned storage, and transactions make it easy to build reliable workflows.",
  },
];

function Hero() {
  return (
    <section className={clsx("hero hero--primary", styles.hero)}>
      <div className="container">
        <h1 className={styles.heroTitle}>JSONVault</h1>
        <p className={styles.heroSubtitle}>
          JSON document storage that lives alongside your code. Build reactive
          apps, run analytics with SQL, and ship migrations without standing up a
          separate database.
        </p>
        <div className={styles.heroButtons}>
          <Link className="button button--lg button--secondary" to="/docs/getting-started/quickstart">
            Get started
          </Link>
          <Link className="button button--lg button--outline button--secondary" to="https://github.com/team-bungfro/jsonvault">
            View on GitHub
          </Link>
        </div>
      </div>
    </section>
  );
}

function FeatureList() {
  return (
    <section className={styles.featuresSection}>
      <div className="container">
        <div className="row">
          {features.map((feature) => (
            <div className="col col--4" key={feature.title}>
              <div className={styles.featureCard}>
                <h3>{feature.title}</h3>
                <p>{feature.description}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function CodeSample() {
  return (
    <section className={styles.codeSection}>
      <div className="container">
        <div className="row">
          <div className="col col--5">
            <h2>What does a JSONVault app look like?</h2>
            <p>
              A few lines let you open a database, attach a schema, and run
              queries using either filter objects or SQL with joins.
            </p>
            <Link className="button button--primary" to="/docs/guides/sql">
              Explore the query guide
            </Link>
          </div>
          <div className="col col--7">
            <pre className={styles.codeBlock}>
              <code>{`const { JsonDatabase, createSchema } = require("jsonvault");

async function main() {
  const db = await JsonDatabase.open({
    path: "./data",
    changeLog: { path: "./data/changelog.jsonl" },
  });

  const users = db.collection("users", {
    schema: createSchema({
      fields: {
        name: { type: "string", required: true },
        email: { type: "string", required: true,
                 transform: (v) => v.toLowerCase() },
      },
    }),
  });

  await users.insertOne({ name: "Ada", email: "ADA@example.com" });

  const results = await db.sql\`
    SELECT users.email, orders.total
    FROM orders
    JOIN users ON orders.userId = users._id
    WHERE orders.total > 1000
  \`;

  console.log(results);
}

main();`}</code>
            </pre>
          </div>
        </div>
      </div>
    </section>
  );
}

function Callout() {
  return (
    <section className={styles.calloutSection}>
      <div className="container">
        <div className={styles.calloutCard}>
          <h2>Ship faster with a database that stays in git</h2>
          <p>
            JSONVault keeps data in human-readable JSON, so snapshots, migrations,
            and audits all live alongside your application. No server to manage,
            no hidden state.
          </p>
          <div className={styles.calloutButtons}>
            <Link className="button button--lg button--secondary" to="/docs/intro">
              Browse the docs
            </Link>
            <Link className="button button--lg button--outline" to="/docs/concepts/change-log">
              Learn about the change log
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}

export default function Home() {
  return (
    <Layout
      title="JSONVault"
      description="JSON document database for Node and Bun with SQL, migrations, encryption, and a durable change log."
    >
      <Hero />
      <main>
        <FeatureList />
        <CodeSample />
        <Callout />
      </main>
    </Layout>
  );
}
