export function AboutPage() {
  return (
    <>
      <div className="page-header">
        <h1>About FlowBoard</h1>
      </div>
      <p>
        FlowBoard is a lightweight project and task dashboard. Create tasks, track their status and
        priority, and see a summary of progress on the dashboard.
      </p>
      <p className="muted">
        This is a frontend-only demo: there is no backend, and tasks are stored in your
        browser&apos;s localStorage. It serves as a stable baseline for exercising pull-request
        validation and release workflows.
      </p>
    </>
  );
}
