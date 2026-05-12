// utils/seoUtils.js

/**
 * Resolve the public site origin used for canonical URLs / OG metadata.
 * Returns a clean origin (no trailing slash) or empty string when not configured.
 * Never falls back to a placeholder host — placeholders would poison SEO if
 * accidentally shipped.
 */
const resolveFrontendOrigin = () => {
    return String(process.env.FRONTEND_URL || '').trim().replace(/\/$/, '');
};

/**
 * Build a canonical product URL from product data and a (possibly empty) origin.
 * Returns null when origin is missing or no usable slug/name is available.
 */
const buildCanonicalProductUrl = (productData, baseUrl) => {
    if (!baseUrl) return null;
    if (productData?.slug) {
        return `${baseUrl}/product/${productData.slug}`;
    }
    if (productData?.name) {
        const fallbackSlug = String(productData.name)
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '');
        if (fallbackSlug) return `${baseUrl}/product/${fallbackSlug}`;
    }
    return null;
};

/**
 * Auto-generate SEO data from product information
 * This runs automatically - no staff intervention needed
 */
const generateSEOData = (productData) => {
    const baseUrl = resolveFrontendOrigin();
    try {
        // Get clean description (remove HTML tags)
        const cleanDescription = productData.description 
            ? productData.description.replace(/<[^>]*>/g, '').substring(0, 160)
            : '';
        
        // Get first variant image for OG image
        let firstImage = null;
        if (productData.variants && productData.variants.length > 0) {
            const firstVariant = productData.variants[0];
            if (firstVariant.images && firstVariant.images.length > 0) {
                firstImage = firstVariant.images[0].url;
            }
        }
        
        // Get category name
        const categoryName = productData.category?.name || productData.category || 'Product';
        
        // Get best price for meta title
        let bestPrice = '';
        if (productData.variants && productData.variants.length > 0) {
            const prices = productData.variants.map(v => 
                v.price.sale != null ? v.price.sale : v.price.base
            );
            const minPrice = Math.min(...prices);
            bestPrice = ` at ₹${minPrice}`;
        }
        
        // =============================================
        // 1. META TITLE (50-60 characters)
        // =============================================
        let metaTitle = `${productData.name}${bestPrice} | Buy Online | OfferWaleBaba`;
        if (metaTitle.length > 60) {
            metaTitle = metaTitle.substring(0, 57) + '...';
        }
        
        // =============================================
        // 2. META DESCRIPTION (150-160 characters)
        // =============================================
        let metaDescription = `${productData.name} - ${cleanDescription || 'Premium quality product'}. ✓ Free Shipping ✓ COD ✓ Easy Returns. Best price guaranteed!`;
        if (metaDescription.length > 160) {
            metaDescription = metaDescription.substring(0, 157) + '...';
        }
        
        // =============================================
        // 3. META KEYWORDS
        // =============================================
        const metaKeywords = `${productData.name}, ${categoryName}, buy online, best price, shop now, ecommerce`;
        
        // =============================================
        // 4. OG TITLE (For social media - max 60 chars)
        // =============================================
        let ogTitle = `${productData.name}${bestPrice}`;
        if (ogTitle.length > 60) {
            ogTitle = ogTitle.substring(0, 57) + '...';
        }
        
        // =============================================
        // 5. OG DESCRIPTION (For social media - max 200 chars)
        // =============================================
        let ogDescription = cleanDescription || productData.name;
        if (ogDescription.length > 200) {
            ogDescription = ogDescription.substring(0, 197) + '...';
        }
        
        // =============================================
        // 6. OG IMAGE
        // =============================================
        const ogImage = firstImage;


        // =============================================
        // 7. CANONICAL URL
        // =============================================
        // Only emit canonical_url when FRONTEND_URL is configured.
        // Never fall back to a placeholder host — Google would index a bogus domain.
        const canonicalUrl = buildCanonicalProductUrl(productData, baseUrl);
        
        return {
            meta_title: metaTitle,
            meta_description: metaDescription,
            meta_keywords: metaKeywords,
            og_title: ogTitle,
            og_description: ogDescription,
            og_image: ogImage,
            canonical_url: canonicalUrl
        };
        
    } catch (error) {
        console.error('Error generating SEO data:', error);
        // Safe fallback — uses outer-scope baseUrl so this branch never
        // throws on its own (avoids "baseUrl is not defined" ReferenceError).
        return {
            meta_title: `${productData?.name || 'Product'} | Buy Online | OfferWaleBaba`,
            meta_description: 'Shop now for best prices with free shipping and COD',
            meta_keywords: 'buy online, best price, shop now',
            og_title: productData?.name || 'Product',
            og_description: 'Shop now for best prices',
            og_image: null,
            canonical_url: buildCanonicalProductUrl(productData, baseUrl)
        };
    }
};

module.exports = { generateSEOData };