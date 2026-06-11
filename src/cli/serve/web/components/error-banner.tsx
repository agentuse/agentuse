export function ErrorBanner(props: { errors: Array<{ projectId: string; storeName?: string; message: string }> }) {
  if (props.errors.length === 0) return null;
  return (
    <div class="errors">
      {props.errors.map((err, index) => (
        <div key={index}>
          {err.projectId}{err.storeName ? `/${err.storeName}` : ''}: {err.message}
        </div>
      ))}
    </div>
  );
}
