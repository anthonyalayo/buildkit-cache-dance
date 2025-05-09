import fs from 'fs/promises';
import path from 'path';
import {CacheOptions, Opts, getCacheMap, getMountArgsString, getTargetPath, getBuilder} from './opts.js';
import { run, runPiped } from './run.js';

async function extractCache(cacheSource: string, cacheOptions: CacheOptions, scratchDir: string, containerImage: string, builder: string) {
    // Prepare Timestamp for Layer Cache Busting
    const date = new Date().toISOString();

    await fs.mkdir(scratchDir, { recursive: true });
    await fs.writeFile(path.join(scratchDir, 'buildstamp'), date);

    // Prepare Dancefile to Access Caches
    const targetPath = getTargetPath(cacheOptions);
    const mountArgs = getMountArgsString(cacheOptions);

    const dancefileContent = `
FROM ${containerImage}
COPY buildstamp buildstamp
RUN --mount=${mountArgs} \
    echo "Contents of ${targetPath}:" && \
    ls -la ${targetPath} && \
    mkdir -p /var/dance-cache/${cacheSource} \
    && cp -p -R ${targetPath}/. /var/dance-cache/${cacheSource} && \
    echo "Contents of /var/dance-cache/${cacheSource}:" && \
    ls -la /var/dance-cache/${cacheSource}
`;
    await fs.writeFile(path.join(scratchDir, 'Dancefile.extract'), dancefileContent);
    console.log("Cache extraction configuration:");
    console.log(`Source: ${cacheSource}`);
    console.log(`Target: ${targetPath}`);
    console.log(`Mount args: ${mountArgs}`);
    console.log("\nDockerfile content:");
    console.log(dancefileContent);

    console.log(`Starting cache extraction for source: ${cacheSource}`);
    console.log(`Target path: ${getTargetPath(cacheOptions)}`);


    const extractArgs = [
        'buildx', 'build',
        ...(builder ? ['--builder', builder] : []),
        '-f', path.join(scratchDir, 'Dancefile.extract'),
        '--tag', 'dance:extract',
        '--load',
        scratchDir
    ];

    // Extract Data into Docker Image
    console.log('Running:', ['docker', ...extractArgs].join(' '));
    await run('docker', extractArgs);

    // Create Extraction Image
    try {
        await run('docker', ['rm', '-f', 'cache-container']);
    } catch (error) {
        // Ignore error if container does not exist
    }
    await run('docker', ['create', '-ti', '--name', 'cache-container', 'dance:extract']);

    // Unpack Docker Image into Scratch
    await runPiped(
        ['docker', ['cp', '-L', 'cache-container:/var/dance-cache', '-']],
        ['tar', ['-H', 'posix', '-x', '-C', scratchDir]]
    );

    console.log(`Checking extracted content in scratch dir:`);
    const files = await fs.readdir(path.join(scratchDir, 'dance-cache', cacheSource));
    console.log('Extracted files:', files);

    // Move Cache into Its Place
    await run('sudo', ['rm', '-rf', cacheSource]);
    await fs.rename(path.join(scratchDir, 'dance-cache', cacheSource), cacheSource);
}

export async function extractCaches(opts: Opts) {
    if (opts["skip-extraction"]) {
        console.log("skip-extraction is set. Skipping extraction step...");
        return;
    }

    const cacheMap = getCacheMap(opts);
    const scratchDir = opts['scratch-dir'];
    const containerImage = opts['utility-image'];
    const builder = getBuilder(opts);

    // Extract Caches for each source-target pair
    for (const [cacheSource, cacheOptions] of Object.entries(cacheMap)) {
        await extractCache(cacheSource, cacheOptions, scratchDir, containerImage, builder);
    }
}
