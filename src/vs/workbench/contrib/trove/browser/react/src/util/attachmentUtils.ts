/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { StagingSelectionItem } from '../../../../common/chatThreadServiceTypes.js';

export const SUPPORTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export type ImageMimeType = typeof SUPPORTED_IMAGE_TYPES[number];

export const SUPPORTED_ATTACHMENT_ACCEPT = [
	...SUPPORTED_IMAGE_TYPES,
	'application/pdf',
].join(',');

const MAX_PDF_PAGES = 15;
const MAX_PDF_TEXT_CHARS = 80_000;
const MAX_PDF_RENDER_PAGES = 3;
const PDF_RENDER_SCALE = 1.5;

export const readFileAsDataUrl = (file: File): Promise<string> => new Promise((resolve, reject) => {
	const reader = new FileReader();
	reader.onload = () => resolve(reader.result as string);
	reader.onerror = reject;
	reader.readAsDataURL(file);
});

export const readFileAsArrayBuffer = (file: File): Promise<ArrayBuffer> => new Promise((resolve, reject) => {
	const reader = new FileReader();
	reader.onload = () => resolve(reader.result as ArrayBuffer);
	reader.onerror = reject;
	reader.readAsArrayBuffer(file);
});

type PdfExtractionResult = {
	text: string;
	pageCount: number;
	previewImages: { dataUrl: string; mimeType: ImageMimeType; fileName: string }[];
};

async function extractPdfContent(file: File): Promise<PdfExtractionResult> {
	const buffer = await readFileAsArrayBuffer(file);
	const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
	pdfjs.GlobalWorkerOptions.workerSrc = '';

	const doc = await pdfjs.getDocument({
		data: buffer,
		useWorkerFetch: false,
		isEvalSupported: false,
		useSystemFonts: true,
	}).promise;

	const pageCount = doc.numPages;
	const textParts: string[] = [];
	const pagesToRead = Math.min(pageCount, MAX_PDF_PAGES);

	for (let pageNum = 1; pageNum <= pagesToRead; pageNum++) {
		const page = await doc.getPage(pageNum);
		const textContent = await page.getTextContent();
		const pageText = textContent.items
			.map(item => ('str' in item ? item.str : ''))
			.join(' ')
			.trim();
		if (pageText) {
			textParts.push(`--- Page ${pageNum} ---\n${pageText}`);
		}
	}

	let text = textParts.join('\n\n').slice(0, MAX_PDF_TEXT_CHARS);
	const previewImages: PdfExtractionResult['previewImages'] = [];

	// Render first pages as images when text is sparse (scanned PDFs) or for vision context
	const shouldRenderPages = text.length < 200 || pageCount <= MAX_PDF_RENDER_PAGES;
	const pagesToRender = shouldRenderPages ? Math.min(pageCount, MAX_PDF_RENDER_PAGES) : 0;

	for (let pageNum = 1; pageNum <= pagesToRender; pageNum++) {
		const page = await doc.getPage(pageNum);
		const viewport = page.getViewport({ scale: PDF_RENDER_SCALE });
		const canvas = document.createElement('canvas');
		canvas.width = viewport.width;
		canvas.height = viewport.height;
		const ctx = canvas.getContext('2d');
		if (!ctx) continue;
		await page.render({ canvasContext: ctx, viewport }).promise;
		const dataUrl = canvas.toDataURL('image/png');
		previewImages.push({
			dataUrl,
			mimeType: 'image/png',
			fileName: `${file.name} (page ${pageNum})`,
		});
	}

	if (!text && previewImages.length > 0) {
		text = `[Scanned PDF with ${pageCount} page(s). Page images attached for visual analysis.]`;
	}

	await doc.destroy();
	return { text, pageCount, previewImages };
}

export async function fileToStagingSelections(file: File): Promise<StagingSelectionItem[]> {
	const mime = file.type || '';
	const isImage = SUPPORTED_IMAGE_TYPES.includes(mime as ImageMimeType)
		|| /\.(png|jpe?g|gif|webp)$/i.test(file.name);

	if (isImage) {
		const dataUrl = await readFileAsDataUrl(file);
		const mimeType = (SUPPORTED_IMAGE_TYPES.includes(mime as ImageMimeType) ? mime : 'image/png') as ImageMimeType;
		return [{
			type: 'Image',
			dataUrl,
			mimeType,
			fileName: file.name,
		}];
	}

	if (mime === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
		try {
			const { text, pageCount, previewImages } = await extractPdfContent(file);
			const pdfSelection: StagingSelectionItem = {
				type: 'Pdf',
				fileName: file.name,
				extractedText: text || `[Could not extract text from ${file.name}]`,
				pageCount,
			};
			const imageSelections: StagingSelectionItem[] = previewImages.map(img => ({
				type: 'Image' as const,
				dataUrl: img.dataUrl,
				mimeType: img.mimeType,
				fileName: img.fileName,
			}));
			return [pdfSelection, ...imageSelections];
		} catch (err) {
			console.error('PDF extraction failed:', err);
			return [{
				type: 'Pdf',
				fileName: file.name,
				extractedText: `[Could not read PDF "${file.name}". Try attaching a screenshot instead.]`,
			}];
		}
	}

	return [];
}

export async function filesToStagingSelections(files: File[]): Promise<StagingSelectionItem[]> {
	const selections: StagingSelectionItem[] = [];
	for (const file of files) {
		selections.push(...await fileToStagingSelections(file));
	}
	return selections;
}

export async function extractAttachmentsFromDataTransfer(dataTransfer: DataTransfer): Promise<StagingSelectionItem[]> {
	const files = Array.from(dataTransfer.files);
	if (files.length > 0) {
		return filesToStagingSelections(files);
	}

	// Clipboard paste: image items only (PDF paste is uncommon)
	const images: StagingSelectionItem[] = [];
	for (const item of Array.from(dataTransfer.items)) {
		if (SUPPORTED_IMAGE_TYPES.includes(item.type as ImageMimeType)) {
			const file = item.getAsFile();
			if (file) {
				images.push(...await fileToStagingSelections(file));
			}
		}
	}
	return images;
}
