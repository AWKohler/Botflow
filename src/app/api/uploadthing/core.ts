import { createUploadthing, type FileRouter } from 'uploadthing/next';
import { auth } from '@/lib/auth/server';

const f = createUploadthing();

// FileRouter for handling project snapshot uploads
export const ourFileRouter = {
  // Route for uploading project thumbnail images
  projectThumbnail: f({
    image: { maxFileSize: '4MB', maxFileCount: 1 },
  })
    .middleware(async () => {
      const { userId } = await auth();
      if (!userId) throw new Error('Unauthorized');
      return { userId };
    })
    .onUploadComplete(async ({ metadata, file }) => {
      console.log('Thumbnail uploaded by user:', metadata.userId);
      console.log('File URL:', file.ufsUrl);
      return { url: file.ufsUrl };
    }),

  // Route for uploading HTML snapshot files
  htmlSnapshot: f({
    'text/html': { maxFileSize: '16MB', maxFileCount: 1 },
  })
    .middleware(async () => {
      const { userId } = await auth();
      if (!userId) throw new Error('Unauthorized');
      return { userId };
    })
    .onUploadComplete(async ({ metadata, file }) => {
      console.log('HTML snapshot uploaded by user:', metadata.userId);
      console.log('File URL:', file.ufsUrl);
      return { url: file.ufsUrl };
    }),
} satisfies FileRouter;

export type OurFileRouter = typeof ourFileRouter;
