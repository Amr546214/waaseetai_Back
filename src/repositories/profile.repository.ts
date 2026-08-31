import { AccountType, PrismaClient } from '@prisma/client';
import { prisma } from '../config/db';
import { UpdateClientProfileInput, UpdateProviderProfileInput } from '../routes/profile/profile.schema';

export class ProfileRepository {
  /**
   * Update Client Profile by User ID
   */
  public async updateClientProfile(userId: string, data: UpdateClientProfileInput) {
    return prisma.clientProfile.update({
      where: { userId },
      data: {
        companyName: data.companyName,
        companySize: data.companySize,
        industry: data.industry,
        website: data.website,
        bio: data.bio
      }
    });
  }

  /**
   * Update Provider Profile by User ID
   */
  public async updateProviderProfile(userId: string, data: UpdateProviderProfileInput) {
    return prisma.providerProfile.update({
      where: { userId },
      data: {
        companyName: data.companyName,
        bio: data.bio,
        hourlyRate: data.hourlyRate,
        yearsOfExperience: data.yearsOfExperience,
        headline: data.headline,
        location: data.location,
        city: data.city,
        country: data.country,
        githubUrl: data.githubUrl,
        linkedinUrl: data.linkedinUrl,
        websiteUrl: data.websiteUrl,
        ...(data.skills
          ? {
              skills: {
                set: [],
                connectOrCreate: data.skills.map((name) => ({
                  where: { name },
                  create: { name }
                }))
              }
            }
          : {})
      }
    });
  }

  /**
   * Get global user details along with their profile based on account type
   */
  public async getProfileByUserId(userId: string, accountType: AccountType) {
    const isClient =
      accountType === AccountType.CLIENT_COMPANY || accountType === AccountType.CLIENT_INDIVIDUAL;

    return prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        phoneCountryCode: true,
        phoneNumber: true,
        accountType: true,
        status: true,
        clientProfile: isClient ? true : false,
        providerProfile: !isClient ? true : false
      }
    });
  }
}

export const profileRepository = new ProfileRepository();
