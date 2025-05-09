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
COPY scratch/buildstamp buildstamp
RUN --mount=${mountArgs} \
    mkdir -p /tmp/${cacheSource} \
    && cp -p -R ${targetPath}/. /tmp/${cacheSource}
`;
    await fs.writeFile(path.join(scratchDir, 'Dancefile.extract'), dancefileContent);

    const extractArgs = [
        'buildx', 'build',
        ...(builder ? ['--builder', builder] : []),
        '-f', path.join(scratchDir, 'Dancefile.extract'),
        '--tag', 'dance:extract', '--load', '.'
    ];

    console.log('Running:', ['docker', ...extractArgs].join(' '));
    console.log(dancefileContent);

    // Extract Data into Docker Image
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
        ['docker', ['cp', '-L', `cache-container:/tmp/${cacheSource}`, '-']],
        ['tar', ['-H', 'posix', '-x', '-C', scratchDir]]
    );

    const files = await fs.readdir(path.join(scratchDir, cacheSource));
    console.log('Extracted files:', files);

    // Move Cache into Its Place
    await run('sudo', ['rm', '-rf', cacheSource]);
    await fs.rename(path.join(scratchDir, cacheSource), cacheSource);
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
