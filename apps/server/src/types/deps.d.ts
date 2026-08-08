// @types/multer declares Express.Multer.File in a global block, but it is not
// imported anywhere and auto-@types inclusion does not pick it up, so every
// `Express.Multer.File` annotation fails to resolve under a real typecheck.
/// <reference types="multer" />
