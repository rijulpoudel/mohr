import { Link } from 'react-router-dom'
import { MohrMark } from '../components/MohrMark'
import styles from './LandingScreen.module.css'

export function LandingScreen() {
  return (
    <div className={styles.landing}>
      <section className={styles.hero} aria-labelledby="landing-headline">
        <div className={styles.heroCopy}>
          <h2 id="landing-headline" className={styles.headline}>
            Where your money went.
            <br />A <em className={styles.headlineItalic}>clearer view</em> of
            your month.
          </h2>
          <p className={styles.supporting}>
            Mohr brings your accounts, transactions, and monthly budgets into
            one clear view.
          </p>
          <div className={styles.actions}>
            <Link className={styles.primaryAction} to="/register">
              Get started
            </Link>
            <Link className={styles.secondaryAction} to="/login">
              Sign in
            </Link>
          </div>
        </div>

        <figure className={styles.preview}>
          <figcaption className={styles.previewCaption}>
            Sample data · a preview of your monthly view
          </figcaption>
          <div className={styles.previewSurface} aria-hidden="true">
            <div className={styles.previewHeader}>
              <span className={styles.previewBrand}>
                <MohrMark size={16} />
                Mohr
              </span>
              <span className={styles.previewMonth}>This month</span>
            </div>
            <dl className={styles.previewMetrics}>
              <div className={styles.previewMetric}>
                <dt>Total balance</dt>
                <dd>$2,480.00</dd>
              </div>
              <div className={styles.previewMetric}>
                <dt>Income this month</dt>
                <dd>$2,000.00</dd>
              </div>
              <div className={styles.previewMetric}>
                <dt>Spending this month</dt>
                <dd>$748.20</dd>
              </div>
              <div className={styles.previewMetric}>
                <dt>Budget remaining</dt>
                <dd>$751.80</dd>
              </div>
            </dl>
            <ul className={styles.previewRows}>
              <li className={styles.previewRowsCaption}>
                Recent transactions · sample
              </li>
              <li>
                <span>Rent</span>
                <span>-$650.00</span>
              </li>
              <li>
                <span>Groceries</span>
                <span>-$98.20</span>
              </li>
              <li>
                <span>Paycheck</span>
                <span>+$2,000.00</span>
              </li>
            </ul>
          </div>
        </figure>
      </section>

      <section
        id="features"
        className={styles.benefits}
        aria-label="What Mohr helps with"
        tabIndex={-1}
      >
        <article className={styles.benefit}>
          <h2>Accounts</h2>
          <p>
            Keep checking, savings, and cash in one place with a current
            balance.
          </p>
        </article>
        <article className={styles.benefit}>
          <h2>Transactions</h2>
          <p>
            Record income and expenses with the date, note, and category that
            give each one meaning.
          </p>
        </article>
        <article className={styles.benefit}>
          <h2>Monthly budgets</h2>
          <p>
            Set a spending limit per category and see what is spent and what
            remains before the month ends.
          </p>
        </article>
      </section>

      <section className={styles.closing} aria-labelledby="landing-closing">
        <h2 id="landing-closing">Understand your month at a glance</h2>
        <p>Start tracking your accounts, transactions, and budgets today.</p>
        <div className={styles.actions}>
          <Link className={styles.primaryAction} to="/register">
            Get started
          </Link>
          <Link className={styles.secondaryAction} to="/login">
            Sign in
          </Link>
        </div>
      </section>
    </div>
  )
}
