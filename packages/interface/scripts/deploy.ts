import childPromise from "child_process";
import { ethers, Signer } from "ethers";
import fs from "fs";
import glob from "glob";
import { ethers as hardhatEthers } from "hardhat";
import { Artifact } from "hardhat/types";
import path from "path";
import process from "process";

const parseArtifact = (path: string) => {
    const jsonString = fs.readFileSync(path, { encoding: "utf-8" });
    return JSON.parse(jsonString) as Artifact;
};

const getContractArtifactsDir = (project: string) =>
    path.join(__dirname, "..", "..", project, "artifacts", "contracts");

const getGlob = (pattern: string, cwd: string) =>
    new Promise<string[]>((res, rej) => {
        glob(pattern, { cwd }, (err, matches) => {
            if (err) {
                rej(err);
            } else {
                res(matches);
            }
        });
    });

const exec = (command: string, cwd: string) => {
    return new Promise<void>((res, rej) => {
        const proc = childPromise.exec(command, { cwd }, (err) => {
            if (err) {
                rej(err);
            } else {
                res();
            }
        });

        proc.stderr?.on("data", (x) => console.error(x));
        proc.stdout?.on("data", (x) => console.log(x));
    });
};

export const buildExternalContracts = async () => {
    await exec("yarn build", path.join(__dirname, "..", "..", "contracts-core"));
    await exec("yarn build", path.join(__dirname, "..", "..", "contracts-periphery"));
};

const getProjectContractArtifacts = async (project: string) => {
    const artifactsDir = getContractArtifactsDir(project);
    const matches = await getGlob("**/*.json", artifactsDir);
    return matches
        .filter(
            (x) =>
                !x.endsWith(".dbg.json") &&
                !x.startsWith("interfaces") &&
                !x.startsWith("test") &&
                !x.startsWith("examples"),
        )
        .map((x) => {
            console.log(x);
            const fullPath = path.join(artifactsDir, x);
            return parseArtifact(fullPath);
        });
};

export const deployExternalContracts = async (
    signer: Signer,
    contracts: string[] | "*" = [],
    erc20Tokens: string[] = [],
) => {
    const priorityContracts = ["ERC20", "WDC"];

    const [signerAddress, coreArtifacts, peripheryArtifacts] = await Promise.all([
        signer.getAddress(),
        getProjectContractArtifacts("contracts-core"),
        getProjectContractArtifacts("contracts-periphery"),
    ]);

    const unorderedArtifacts = [...coreArtifacts, ...peripheryArtifacts];
    const priorityArtifacts = unorderedArtifacts.filter((x) => priorityContracts.includes(x.contractName));
    const nonPriorityArtifacts = unorderedArtifacts.filter((x) => !priorityContracts.includes(x.contractName));
    const artifacts = [...priorityArtifacts, ...nonPriorityArtifacts];

    console.log(artifacts.map((x) => x.contractName));

    const addresses: Record<string, string> = {};

    for (const artifact of artifacts) {
        if (contracts !== "*" && !contracts.includes(artifact.contractName)) {
            continue;
        }

        const deployContract = (...args: any[]) => deployNamedContract(artifact.contractName, ...args);

        const deployNamedContract = async (name: string, ...args: any[]) => {
            const contractFactory = await hardhatEthers.getContractFactoryFromArtifact(artifact);
            let contract: ethers.Contract;
            try {
                contract = await contractFactory.deploy(...args);
            } catch (e) {
                console.error(`Error deploying ${name}\n`, e);
                process.exit(1);
            }

            addresses[name] = contract.address;
            console.log(`Deployed ${name}`.padEnd(40), contract.address);
        };

        switch (artifact.contractName) {
            case "ERC20":
                for (const erc20Token of erc20Tokens) {
                    console.log(erc20Token);
                    await deployNamedContract(erc20Token, erc20Token, erc20Token, ethers.utils.parseEther("1000000"));
                }
                break;
            case "DogeSwapV2Factory":
                await deployContract(signerAddress);
                break;
            case "DogeSwapV2Router":
                console.log(addresses["DogeSwapV2Factory"]);
                console.log(addresses["WDC"]);
                await deployContract(addresses["DogeSwapV2Factory"], addresses["WDC"]);
                break;
            default:
                await deployContract();
        }
    }

    return addresses;
};
