import { type ApiError, SupabaseManager } from "@0xbigboss/supabase-manager";
import * as core from "@actions/core";

process.on("unhandledRejection", handleError);
main().catch(handleError);

export async function main(): Promise<void> {
	const sbToken = core.getInput("supabase-access-token", { required: true });
	const sbRef = core.getInput("supabase-project-id", { required: true });
	const waitForMigrations = core.getBooleanInput("wait-for-migrations");
	const timeout = Number(core.getInput("timeout")); // timeout in seconds

	core.setSecret(sbToken); // users maybe set it up as ENV var
	core.setSecret(sbRef); // users maybe set it up as ENV var

	if (!sbToken) {
		core.setFailed("Supabase access token is not defined");
		return;
	}

	if (!sbRef) {
		core.setFailed("Supabase project id is not defined");
		return;
	}

	if (Number.isNaN(timeout)) {
		core.setFailed("Timeout is not a valid number");
		return;
	}

	const supabase = new SupabaseManager({
		TOKEN: sbToken,
		BASE: "https://api.supabase.com",
	});

	// find branch name
	let branchName = process.env.GITHUB_HEAD_REF; // default to GITHUB_HEAD_REF if available (for PRs)
	if (!branchName) {
		// if not available, try to get it from GITHUB_REF
		branchName = (process.env.GITHUB_REF ?? "").split("refs/heads/")[1];
	}
	console.log(branchName);

	if (!branchName) {
		core.setFailed("Git branch not found");
		return;
	}

	core.info(`Current Git branch: ${branchName}`);

	// main loop: find the supabase branch ID of the database preview branch
	// (optionally) wait for the migrations to be applied
	// up to a certain timeout
	const now = Date.now();
	while (Date.now() - now < timeout * 1000) {
		const branches = await supabase.databaseBranchesBeta
			.getBranches({
				ref: sbRef,
			})
			.catch((err: ApiError) => {
				if (err.status === 429 || err.status >= 500) {
					core.warning(`Failed fetching fetching branches: ${err}`);
					return [];
				}
				const _err = new Error("Failed fetching fetching branches");
				_err.cause = err;
				throw _err;
			});
		const currentBranch = branches.find((b) => b.name === branchName);
		// https://github.com/supabase/supabase/blob/7ad6594648a1d33a034b32a31148c031200a2c46/apps/studio/components/interfaces/BranchManagement/BranchStatusBadge.tsx#L27
		if (
			currentBranch &&
			(!waitForMigrations || currentBranch.status === "MIGRATIONS_PASSED" || currentBranch.status === "FUNCTIONS_DEPLOYED")
		) {
			core.info(`Branch ${branchName} found, status: ${currentBranch.status}`);
			const branchDetails = await supabase.databaseBranchesBeta
				.getBranchDetails({
					branchId: currentBranch.id,
				})
				.catch((err: ApiError) => {
					if (err.status === 429 || err.status >= 500) {
						core.warning(`Error fetching branch details: ${err}`);
						return null;
					}
					const _err = new Error("Error fetching branch details");
					_err.cause = err;
					throw _err;
				});

			if (!branchDetails) {
				core.warning("Branch details not found");
				continue;
			}

			const apiKeys = await supabase.projects
				.getProjectApiKeys({
					ref: currentBranch.project_ref,
				})
				.catch((err: ApiError) => {
					if (err.status === 429 || err.status >= 500) {
						core.warning(`Error fetching api keys: ${err}`);
						return null;
					}
					const _err = new Error("Error fetching api keys");
					_err.cause = err;
					throw _err;
				});

			if (!apiKeys) {
				core.warning("Api keys not found");
				continue;
			}

			// set outputs and mask secrets
			for (const key of apiKeys) {
				core.setSecret(key.api_key);
				core.setOutput(`${key.name}_key`, key.api_key);
			}

			const branchKeys = [
				"id",
				"name",
				"project_ref",
				"parent_project_ref",
				"git_branch",
				"pr_number",
				"reset_on_push",
				"status",
				"created_at",
				"updated_at",
			] as const;
			for (let key of branchKeys) {
				const value = currentBranch[key];
				if (value) {
					if (value === "status") {
						key += "branch_status";
					}
					core.setSecret(value.toString());
					core.setOutput(key, value.toString());
				}
			}

			const branchDetailsKeys = [
				"db_host",
				"db_port",
				"db_user",
				"db_pass",
				"jwt_secret",
			] as const;
			for (const key of branchDetailsKeys) {
				const value = branchDetails[key];
				if (value) {
					core.setSecret(value.toString());
					core.setOutput(key, value.toString());
				}
			}

			core.setOutput(
				"api_url",
				`https://${branchDetails.ref}.supabase.co/rest/v1`,
			);
			core.setOutput(
				"graphql_url",
				`https://${branchDetails.ref}.supabase.co/graphql/v1`,
			);
			core.info("success");
			return; // success
		}

		core.info(
			`Waiting for branch ${branchName} to be created. Status=${currentBranch?.status}`,
		);
		await new Promise((resolve) => setTimeout(resolve, 2900));
	}

	core.setFailed(`Timeout waiting for branch ${branchName} to be created`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
// biome-ignore lint/suspicious/noExplicitAny: err can be any type
function handleError(err: any): void {
	console.error(err);
	core.setFailed(`Unhandled error: ${err}`);
}
