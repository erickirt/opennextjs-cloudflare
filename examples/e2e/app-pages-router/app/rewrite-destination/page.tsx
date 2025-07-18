export default async function RewriteDestination(props: {
	searchParams: Promise<{ a: string; multi?: string[] }>;
}) {
	const searchParams = await props.searchParams;
	return (
		<div>
			<div>Rewritten Destination</div>
			<div>a: {searchParams.a}</div>
			<div>multi: {searchParams.multi?.join(", ")}</div>
		</div>
	);
}
